#!/usr/bin/env bash
# Build Plotina's Cinny Desktop from a pinned upstream tag.
#
#   scripts/build.sh            # current platform
#
# Expects: rust, node/npm, Tauri's system deps (webkit2gtk-4.1, gtk3,
# libayatana-appindicator, librsvg) and the noise assets (fetch-noise.py fills
# them in when they are missing).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="${WORK:-$ROOT/.build}"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"
REPO="https://github.com/cinnyapp/cinny-desktop.git"
OVERLAY="$ROOT/tauri.plotina.json"

echo "==> upstream $TAG in $WORK"
mkdir -p "$WORK"
if [ ! -d "$WORK/cinny-desktop/.git" ]; then
  git clone --depth 1 --branch "$TAG" --recurse-submodules --shallow-submodules "$REPO" "$WORK/cinny-desktop"
fi
cd "$WORK/cinny-desktop"
git fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
git checkout --quiet "$TAG"
git submodule update --init --recursive --depth 1

# The name that groups events in GlitchTip; it must be the same string CI
# uploads the source maps for. At a tag that is the tag itself, otherwise a
# local name that is easy to filter out in the dashboard.
SENTRY_RELEASE="${VITE_SENTRY_RELEASE:-cinny@$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || printf '%s-local' "$TAG")}"

echo "==> noise assets"
python3 "$ROOT/scripts/fetch-noise.py"
# DPDFNet backend binaries (ort wasm + model): pinned by dpdfnet.lock.json,
# same policy as the DFN3 assets above. Without them apply-noise.py fails.
python3 "$(dirname "$ROOT")/noise/scripts/fetch-dpdfnet.py" --dest "$ROOT/noise"

echo "==> plotina patches ($SENTRY_RELEASE)"
cd cinny
for PATCH in "$ROOT"/patches/*.patch; do
  if git apply --check "$PATCH" 2>/dev/null; then
    git apply "$PATCH"
    echo "applied: $(basename "$PATCH")"
  elif git apply -R --check "$PATCH" 2>/dev/null; then
    echo "already applied: $(basename "$PATCH")"
  else
    echo "build.sh: $PATCH does not apply; upstream source changed" >&2
    exit 1
  fi
done

echo "==> web build"
[ -d node_modules ] || npm ci
# @sentry/browser is not in upstream's package.json on purpose: --no-save
# leaves both package.json and package-lock.json untouched, and letting npm
# read the lock file keeps transitive pins like @swc/core intact (a newer)
# @swc/core breaks vite-plugin-top-level-await).
npm install --no-save --no-audit --no-fund "@sentry/browser@${SENTRY_SDK_VERSION:-10.27.0}"
# Same policy for the desktop updater UI: the Settings page imports the Tauri
# plugin JS, which upstream's frontend does not list as a dependency.
# Versions must match the root package.json of the pinned cinny-desktop tag.
npm install --no-save --no-audit --no-fund \
  "@tauri-apps/api@2.7.0" "@tauri-apps/plugin-updater@2.9.0" \
  "@tauri-apps/plugin-process@2.3.0" "@tauri-apps/plugin-http@2.5.1"
VITE_SENTRY_DSN="${VITE_SENTRY_DSN:-}" VITE_SENTRY_RELEASE="$SENTRY_RELEASE" npm run build

# Maps are stripped before the dist goes into a Tauri binary or onto the edge.
echo "==> source maps"
CLI=()
if [ -n "${SENTRY_CLI:-}" ]; then CLI=(--sentry-cli "$SENTRY_CLI"); fi
python3 "$ROOT/scripts/sentry-sourcemaps.py" --dist dist \
  --out "${MAPS_OUT:-$WORK/sourcemaps}" --release "$SENTRY_RELEASE" \
  "${CLI[@]+"${CLI[@]}"}"

echo "==> patch"
cd ..
# Desktop shell patches live next to the frontend ones but apply to the
# cinny-desktop checkout (git root), not to its cinny submodule.
for PATCH in "$ROOT"/desktop-patches/*.patch; do
  if git apply --check "$PATCH" 2>/dev/null; then
    git apply "$PATCH"
    echo "applied: $(basename "$PATCH")"
  elif git apply -R --check "$PATCH" 2>/dev/null; then
    echo "already applied: $(basename "$PATCH")"
  else
    echo "build.sh: $PATCH does not apply; upstream source changed" >&2
    exit 1
  fi
done
cp "$ROOT/config.json" config.json
python3 "$ROOT/apply-noise.py" --dist cinny/dist --noise "$ROOT/noise"
python3 "$ROOT/branding.py" --dist cinny/dist --brand "Plotina Lite Desktop"

# Tauri gets the provisional Plotina mark for the window, the launcher and the
# Windows installer; upstream's Cinny bird stays out of the shipped bundle.
for icon in 32x32.png 128x128.png 128x128@2x.png icon.png icon.ico; do
  cp "$ROOT/icons/$icon" "src-tauri/icons/$icon"
done

echo "==> tauri shell deps"
[ -d node_modules ] || npm ci

# linuxdeploy bundles an old binutils whose strip cannot read .relr.dyn sections
# produced by current toolchains (Arch/CachyOS, deb13). Stripping is cosmetic here,
# so disable it; without FUSE2 the AppImage tool has to extract itself first.
export NO_STRIP=1
export APPIMAGE_EXTRACT_AND_RUN=1

echo "==> updater signing"
# CI signs every bundle (bundle.createUpdaterArtifacts is true). Locally the key
# is picked up from ~/.tauri/plotina-lite.key when it is there — Tauri takes
# either the file content or its path, so a machine holding the key needs no
# extra setup. NO_UPDATER=1 builds an unsigned, NOT FOR RELEASE bundle for
# throwaway testing; see cinny/README.md ("Updater") before publishing from
# anywhere but CI.
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -f "$HOME/.tauri/plotina-lite.key" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/plotina-lite.key"
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ] && [ -f "$HOME/.tauri/plotina-lite.key.password" ]; then
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$HOME/.tauri/plotina-lite.key.password")"
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -z "${NO_UPDATER:-}" ]; then
  echo "build.sh: no updater signing key available." >&2
  echo "  set TAURI_SIGNING_PRIVATE_KEY (+ _PASSWORD), put the key at" >&2
  echo "  ~/.tauri/plotina-lite.key, or run with NO_UPDATER=1 for an unsigned" >&2
  echo "  local-only bundle that no client can install as an update." >&2
  exit 1
fi

echo "==> stamped build config"
# Upstream pins the app version to the Cinny tag; the updater needs a version
# that changes with every Plotina build, so the version is stamped from the tag
# this checkout sits on (empty for a branch build -> the dev slot).
REF_NAME="${REF_NAME:-$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || true)}"
BUILD_CONFIG="$WORK/tauri.plotina.build.json"
CONFIG_ARGS=(config --overlay "$OVERLAY" --out "$BUILD_CONFIG"
             --ref-name "$REF_NAME" --upstream-tag-file "$ROOT/UPSTREAM_TAG")
if [ -n "${NO_UPDATER:-}" ]; then CONFIG_ARGS+=(--no-updater-artifacts); fi
python3 "$HERE/build_config.py" "${CONFIG_ARGS[@]}"

echo "==> installers"
# Windows can be produced from Linux via cargo-xwin + NSIS (experimental upstream):
#   CROSS=windows scripts/build.sh
if [ "${CROSS:-}" = "windows" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
  npm run tauri -- build --config "$BUILD_CONFIG" \
    --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
  echo
  echo "done:"
  find src-tauri/target/x86_64-pc-windows-msvc/release/bundle -maxdepth 2 -type f -name '*.exe' -printf '  %p (%s bytes)\n'
  exit 0
fi

case "$(uname -s)" in
  Linux)  BUNDLES=appimage,deb ;;
  Darwin) BUNDLES=dmg ;;
  *)      BUNDLES=nsis ;;
esac
npm run tauri -- build --config "$BUILD_CONFIG" --bundles "$BUNDLES"

# Tauri keeps the upstream maintainer in the deb control file and would show
# it in package managers; reuse the desktop post-processor with our name.
for deb in src-tauri/target/release/bundle/deb/*.deb; do
  [ -f "$deb" ] || continue
  PRODUCT_NAME="Plotina Lite Desktop" \
    "$ROOT/../element-desktop/scripts/fix-deb-branding.sh" "$deb"
done

echo
echo "done:"
find src-tauri/target/release/bundle -maxdepth 2 -type f \( -name '*.AppImage' -o -name '*.AppImage.sig' -o -name '*.deb' -o -name '*.msi' -o -name '*.exe' -o -name '*.exe.sig' -o -name '*.dmg' \) -printf '  %p (%s bytes)\n'
if [ -n "${NO_UPDATER:-}" ]; then
  echo
  echo "UNSIGNED local build (NO_UPDATER=1): these files are not installable as an"
  echo "update and must not be published. Release bundles come from CI, which signs."
fi
