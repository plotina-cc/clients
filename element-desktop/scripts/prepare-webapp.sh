#!/usr/bin/env bash
# Assemble the Element Web bundle that the desktop shell embeds.
#
#   scripts/prepare-webapp.sh [--dest element-desktop/.build/webapp]
#
# The desktop shell has no way to load a remote webapp: upstream packs a webapp
# directory into webapp.asar and serves it from vector://vector/webapp/. This
# script produces that directory: the pinned upstream release build plus our
# noise overlay and config.json.
#
# WEBAPP_DIR  use an already unpacked webapp instead of the release tarball, for
#             example `docker cp plotina/element-web-1.12.32:/app webapp`.
# WORK        where the tarball and the assembly live (default: .build)
# NOISE       where the DeepFilterNet3 assets are downloaded (default: noise)
# PYTHON      interpreter to use (default: python3, falling back to python)
# SENTRY_DSN  GlitchTip DSN written into the webapp's config.json; required, and
#             obtained from the SENTRY_DSN repository variable in CI
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
REPO_ROOT="$(dirname "$ROOT")"
WORK="${WORK:-$ROOT/.build}"
NOISE="${NOISE:-$ROOT/noise}"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"
DEST="$WORK/webapp"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a path}"; shift 2 ;;
    *) echo "usage: $0 [--dest <dir>]" >&2; exit 2 ;;
  esac
done

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python
command -v "$PYTHON" >/dev/null 2>&1 || { echo "prepare-webapp: no python interpreter" >&2; exit 1; }

echo "==> webapp for $TAG"
rm -rf "$DEST"
mkdir -p "$DEST" "$WORK"

if [ -n "${WEBAPP_DIR:-}" ]; then
  [ -f "$WEBAPP_DIR/index.html" ] || { echo "prepare-webapp: $WEBAPP_DIR has no index.html" >&2; exit 1; }
  echo "    from $WEBAPP_DIR"
  cp -a "$WEBAPP_DIR/." "$DEST/"
else
  LOCK_LINE="$("$PYTHON" - "$ROOT/webapp.lock.json" "$TAG" <<'PY'
import json
import sys

lock = json.load(open(sys.argv[1], encoding="utf-8"))
tag = sys.argv[2]
if lock.get("tag") != tag:
    sys.exit(f"webapp.lock.json pins {lock.get('tag')!r} but UPSTREAM_TAG is {tag!r}: update both together")
print(lock["url"], lock["sha256"])
PY
  )"
  URL="${LOCK_LINE%% *}"
  SHA="${LOCK_LINE##* }"
  TARBALL="$WORK/$(basename "$URL")"
  if [ -f "$TARBALL" ] && echo "$SHA  $TARBALL" | sha256sum -c - >/dev/null 2>&1; then
    echo "    cached $TARBALL"
  else
    echo "    fetch $URL"
    curl -fL --retry 3 --max-time 3600 -o "$TARBALL.part" "$URL"
    echo "$SHA  $TARBALL.part" | sha256sum -c -
    mv "$TARBALL.part" "$TARBALL"
  fi
  tar xzf "$TARBALL" -C "$DEST" --strip-components=1
fi

echo "==> noise layer"
mkdir -p "$NOISE/vendor"
cp "$REPO_ROOT/noise/logic.js" "$REPO_ROOT/noise/boot.js" "$NOISE/"
cp -a "$REPO_ROOT/noise/vendor/." "$NOISE/vendor/"

echo "==> noise assets"
"$PYTHON" "$REPO_ROOT/cinny/scripts/fetch-noise.py" --dest "$NOISE"
"$PYTHON" "$REPO_ROOT/noise/scripts/fetch-dpdfnet.py" --dest "$NOISE"

echo "==> config"
# The DSN is the one deployment value that may change without a commit:
# element-web/config.json keeps the current one, SENTRY_DSN overrides it (CI
# passes the repository variable). render-config.py fails the build if the
# result could not report (no sentry object, empty or non-hex key, wrong
# environment), instead of shipping an app that is silent about crashes.
CONFIG="$WORK/element-web-config.json"
"$PYTHON" "$REPO_ROOT/element-web/scripts/render-config.py" --out "$CONFIG"

echo "==> overlay"
"$PYTHON" "$ROOT/apply-noise.py" --webapp "$DEST" --noise "$NOISE" \
  --config "$CONFIG" --brand "Plotina Desktop"

# Branding runs after the noise overlay: apply-noise.py owns the JS hooks and
# config.json, branding.py owns the browser-facing shell (title, icons, meta,
# error view) and must see the final index.html.
echo "==> branding"
"$PYTHON" "$ROOT/branding.py" --webapp "$DEST" --icons "$REPO_ROOT/branding/icons"

# The webapp directory becomes webapp.asar inside the installer; the licence
# text and the modification notice have to travel with it. Byte-identical to
# ../LICENSE and ../NOTICE.
echo "==> licence"
install -m 0644 "$REPO_ROOT/LICENSE" "$DEST/LICENSE-AGPL-3.0"
install -m 0644 "$REPO_ROOT/NOTICE" "$DEST/NOTICE"

echo "==> verify"
grep -q 'noise/boot.js' "$DEST/index.html"
grep -q 'noise/logic.js' "$DEST/index.html"
grep -q 'Plotina Desktop' "$DEST/index.html"
if grep -q '>Element</title>' "$DEST/index.html"; then
  echo "prepare-webapp: the Element title is still in index.html" >&2; exit 1
fi
if grep -q 'element-app-logo' "$DEST"/bundles/*/error-view.js; then
  echo "prepare-webapp: the Element logo is still in error-view.js" >&2; exit 1
fi
test ! -e "$DEST/mobile_guide"
test -s "$DEST/LICENSE-AGPL-3.0"
test -s "$DEST/NOTICE"
test -f "$DEST/noise/vendor/dfn.esm.js"
test -f "$DEST/noise/dfn/v3/pkg/df_bg.wasm"
test -f "$DEST/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz"
test -f "$DEST/noise/vendor/dpdfnet.esm.js"
test -f "$DEST/noise/vendor/ort/ort.wasm.bundle.min.mjs"
test -f "$DEST/noise/vendor/ort/ort-wasm-simd-threaded.wasm"
test -f "$DEST/noise/vendor/dpdfnet/dpdfnet2_48khz_hr/model_stateful.onnx"
test -f "$DEST/config.json"
"$PYTHON" "$REPO_ROOT/element-web/scripts/render-config.py" --check --config "$DEST/config.json"

# Parity with the Element Web image: every fix ../element-web/webapp_fixes.py
# ships into /app must provably be in this webapp too (element-desktop/
# README.md, "Parity with Element Web"). branding.py already fails the build
# when one is missing; these greps re-verify the final bytes, the same way
# the web Dockerfile does after its own brand pass.
count() {  # occurrences of a literal string in a file (grep -c counts lines)
  { grep -oF -e "$1" "$2" || true; } | wc -l
}
test -s "$DEST/plotina-theme.js"
cmp -s "$DEST/plotina-theme.js" "$REPO_ROOT/element-web/plotina-theme.js"
# Relative src only: vector://vector/webapp/ never serves a root-absolute path.
[ "$(count '<script src="plotina-theme.js"></script>' "$DEST/index.html")" -eq 1 ]
if grep -q 'src="/plotina-theme.js"' "$DEST/index.html"; then
  echo "prepare-webapp: root-absolute plotina-theme.js src in the desktop webapp" >&2; exit 1
fi
# The modal a11y block lands exactly once and carries no margin override
# (stock auto margins pin the auth footer to the viewport bottom).
[ "$(count '<style id="plotina-modal-a11y">' "$DEST/index.html")" -eq 1 ]
if grep -q '.mx_AuthPage_modal{' "$DEST/index.html"; then
  echo "prepare-webapp: the modal a11y block overrides .mx_AuthPage_modal margins" >&2; exit 1
fi
# 133 contrast fallbacks per custom sheet, no fallback-less use left.
for sheet in "$DEST"/bundles/*/theme-light-custom.css \
             "$DEST"/bundles/*/theme-dark-custom.css; do
  n="$(count 'var(--timeline-text-color,var(--cpd-color-text-primary))' "$sheet")"
  [ "$n" -eq 133 ] || { echo "prepare-webapp: $sheet has $n fallbacks, expected 133" >&2; exit 1; }
done
if grep -qF 'var(--timeline-text-color)' \
  "$DEST"/bundles/*/theme-light-custom.css "$DEST"/bundles/*/theme-dark-custom.css; then
  echo "prepare-webapp: a custom theme still has a bare var(--timeline-text-color)" >&2; exit 1
fi
grep -q 'sign_out_before_verify' "$DEST"/i18n/ru.*.json

echo "webapp ready: $DEST ($(du -sh "$DEST" | cut -f1))"
