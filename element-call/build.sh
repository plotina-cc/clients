#!/usr/bin/env bash
#
# Assemble the self-hosted Element Call bundle for plotina.cc.
#
# Two modes:
#   release (default)  take the upstream release tarball, verify its SHA-256,
#                      inject noise/, add config.json. No toolchain, ~40 MB of
#                      downloads, seconds of CPU.
#   source             clone the tag and run `pnpm build:full`. Only worth it
#                      when we carry a change that cannot be applied to the
#                      built bundle — the release tarball is upstream's own
#                      build output for that tag.
#
# Usage:
#   element-call/build.sh [options]
#
#   --mode release|source   default: release
#   --tag vX.Y.Z            default: EC_TAG from pins.env
#   --out DIR               default: <repo>/dist
#   --noise DIR             default: <repo>/noise
#   --dfn-dir DIR           existing noise/dfn tree (v3/pkg, v3/models) instead
#                           of downloading the two assets
#   --config FILE           default: element-call/config.json
#   --keep                  keep the work directory for inspection
#
# Output: $OUT/plotina-element-call.tar.gz containing element-call-plotina/.

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$HERE/.." && pwd)"

# shellcheck source=pins.env
. "$HERE/pins.env"

MODE=release
TAG="$EC_TAG"
OUT="$REPO/dist"
NOISE="$REPO/noise"
DFN_DIR=""
CONFIG="$HERE/config.json"
KEEP=0

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --mode)    MODE="${2:?--mode needs a value}"; shift 2 ;;
    --tag)     TAG="${2:?--tag needs a value}"; shift 2 ;;
    --out)     OUT="${2:?--out needs a value}"; shift 2 ;;
    --noise)   NOISE="${2:?--noise needs a value}"; shift 2 ;;
    --dfn-dir) DFN_DIR="${2:?--dfn-dir needs a value}"; shift 2 ;;
    --config)  CONFIG="${2:?--config needs a value}"; shift 2 ;;
    --keep)    KEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$MODE" in
  release|source) ;;
  *) die "--mode must be release or source, not '$MODE'" ;;
esac

for f in "$NOISE/logic.js" "$NOISE/boot.js" "$NOISE/vendor/dfn.esm.js" "$CONFIG"; do
  [ -f "$f" ] || die "missing input: $f"
done

file_size() {
  stat -c %s "$1" 2>/dev/null || stat -f %z "$1"
}

WORK="$(mktemp -d)"
cleanup() {
  if ((KEEP)); then
    say "work directory kept: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# --- upstream ------------------------------------------------------------

fetch_release() {
  local url
  url="https://github.com/element-hq/element-call/releases/download/$TAG/element-call-${TAG#v}.tar.gz"

  if [ "$TAG" != "$EC_TAG" ]; then
    die "--tag $TAG is not the pinned $EC_TAG; bump EC_TAG and EC_TARBALL_SHA256 in pins.env together"
  fi

  say "downloading $url"
  curl -fsSL --retry 3 --retry-delay 2 -o "$WORK/upstream.tar.gz" "$url"
  echo "$EC_TARBALL_SHA256  $WORK/upstream.tar.gz" | sha256sum -c -

  say "extracting"
  tar -xzf "$WORK/upstream.tar.gz" -C "$WORK"
  [ -d "$WORK/element-call-${TAG#v}" ] || die "unexpected tarball layout: no element-call-${TAG#v}/"
  mv "$WORK/element-call-${TAG#v}" "$WORK/dist"
}

build_from_source() {
  command -v node >/dev/null || die "--mode source needs node $NODE_VERSION on PATH"

  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt "$NODE_VERSION" ]; then
    say "warning: upstream pins Node $NODE_VERSION, found $(node -v)"
  fi

  say "cloning $EC_REPO at $TAG"
  git clone --depth 1 --branch "$TAG" "$EC_REPO" "$WORK/src"

  if compgen -G "$HERE/patches/*.patch" > /dev/null; then
    say "applying plotina patches"
    for patch in "$HERE"/patches/*.patch; do
      ( cd "$WORK/src" && git apply --verbose "$patch" )
    done
  fi

  if ! command -v pnpm >/dev/null; then
    say "activating pnpm@$PNPM_VERSION through corepack"
    corepack enable
    corepack prepare "pnpm@$PNPM_VERSION" --activate
  fi

  say "pnpm install && pnpm build:full (this is the 16 GB, 10-20 minute part)"
  (
    cd "$WORK/src"
    pnpm install --frozen-lockfile
    pnpm build:full
  )

  [ -f "$WORK/src/dist/index.html" ] || die "the build produced no dist/index.html"
  # The processor module itself is loaded at runtime from /noise/vendor, so the
  # bundle can only be checked for our glue code.
  grep -rq "DeepFilterNet3 attached to the microphone track" "$WORK/src/dist/assets" \
    || die "the Plotina track-processor glue is not in the bundle"
  mv "$WORK/src/dist" "$WORK/dist"
}

case "$MODE" in
  release) fetch_release ;;
  source)  build_from_source ;;
esac

DIST="$WORK/dist"

# --- noise ---------------------------------------------------------------

say "patching index.html"
python3 "$HERE/inject-noise.py" "$DIST/index.html"
python3 "$HERE/inject-noise.py" --check "$DIST/index.html"

say "copying noise/ into the bundle"
mkdir -p "$DIST/noise/vendor"
install -m 0644 "$NOISE/logic.js" "$NOISE/boot.js" "$NOISE/plotina-dfn.js" "$DIST/noise/"
install -m 0644 "$NOISE/vendor/dfn.esm.js" "$DIST/noise/vendor/"
# The vendored module is third-party; its licences travel with it.
for lic in "$NOISE"/vendor/LICENSE-*; do
  if [ -e "$lic" ]; then
    install -m 0644 "$lic" "$DIST/noise/vendor/"
  fi
done

mkdir -p "$DIST/noise/dfn/v3/pkg" "$DIST/noise/dfn/v3/models"
if [ -n "$DFN_DIR" ]; then
  say "copying DeepFilterNet3 assets from $DFN_DIR"
  install -m 0644 "$DFN_DIR/v3/pkg/df_bg.wasm" "$DIST/noise/dfn/v3/pkg/"
  install -m 0644 "$DFN_DIR/v3/models/DeepFilterNet3_onnx.tar.gz" "$DIST/noise/dfn/v3/models/"
else
  say "downloading DeepFilterNet3 assets"
  curl -fsSL --retry 3 --retry-delay 2 -o "$DIST/noise/dfn/v3/pkg/df_bg.wasm" \
    "$DFN_BASE/pkg/df_bg.wasm"
  curl -fsSL --retry 3 --retry-delay 2 -o "$DIST/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz" \
    "$DFN_BASE/models/DeepFilterNet3_onnx.tar.gz"
fi
echo "$DFN_WASM_SHA256  $DIST/noise/dfn/v3/pkg/df_bg.wasm" | sha256sum -c -
echo "$DFN_MODEL_SHA256  $DIST/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz" | sha256sum -c -

# --- config --------------------------------------------------------------

say "installing config.json"
python3 - "$CONFIG" "$DIST/config.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as fh:
    config = json.load(fh)
hs = config.get("default_server_config", {}).get("m.homeserver", {})
if not hs.get("base_url") or not hs.get("server_name"):
    sys.exit("config.json: default_server_config.m.homeserver needs base_url and server_name")
if config.get("matrix_rtc_mode") not in (None, "compatibility", "matrix_2_0"):
    sys.exit("config.json: matrix_rtc_mode must be compatibility or matrix_2_0")
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(config, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
PY

# Upstream's LICENSE-AGPL-3.0 is byte-identical to our repository LICENSE, and
# the release tarball ships no licence files at all, so carry it in the bundle.
install -m 0644 "$REPO/LICENSE" "$DIST/LICENSE-AGPL-3.0"

# --- assertions ----------------------------------------------------------

say "checking the bundle"
python3 "$HERE/inject-noise.py" --check "$DIST/index.html" >/dev/null
grep -q '/noise/logic.js' "$DIST/index.html" || die "logic.js tag missing from index.html"
grep -q 'assets/' "$DIST/index.html" || die "no asset references in index.html; wrong tarball?"
compgen -G "$DIST/assets/index-*.js" >/dev/null || die "no hashed app bundle under assets/"
[ -s "$DIST/config.json" ] || die "config.json is empty"

wasm_size="$(file_size "$DIST/noise/dfn/v3/pkg/df_bg.wasm")"
model_size="$(file_size "$DIST/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz")"
[ "$wasm_size" -gt 10000000 ] || die "df_bg.wasm is ${wasm_size}B; expected ~16 MB"
[ "$model_size" -gt 7000000 ] || die "model is ${model_size}B; expected ~8 MB"

# --- package -------------------------------------------------------------

STAGE="$WORK/stage"
mkdir -p "$STAGE/element-call-plotina"
cp -a "$DIST/." "$STAGE/element-call-plotina/"

mkdir -p "$OUT"
ART="$OUT/plotina-element-call.tar.gz"

# Same input, same bytes: makes a rebuild comparable with the published asset.
# The ${arr[@]+...} form keeps bash 3.2 (macOS) from tripping over an empty
# array under `set -u`.
TAR_FLAGS=()
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  TAR_FLAGS=(--sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner)
fi

say "packing $ART"
tar ${TAR_FLAGS[@]+"${TAR_FLAGS[@]}"} -czf "$ART" -C "$STAGE" element-call-plotina

say "done"
printf '    artifact  %s (%s)\n' "$ART" "$(du -h "$ART" | cut -f1)"
printf '    sha256    %s\n' "$(sha256sum "$ART" | cut -d' ' -f1)"
printf '    upstream  element-call %s (%s)\n' "$TAG" "$MODE mode"
printf '    files     %s\n' "$(find "$STAGE/element-call-plotina" -type f | wc -l)"
