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

echo "==> sentry patch ($SENTRY_RELEASE)"
cd cinny
PATCH="$ROOT/patches/0001-plotina-sentry.patch"
if git apply --check "$PATCH" 2>/dev/null; then
  git apply "$PATCH"
elif git apply -R --check "$PATCH" 2>/dev/null; then
  echo "already applied"
else
  echo "build.sh: $PATCH does not apply; upstream src/index.tsx or vite.config.js changed" >&2
  exit 1
fi

echo "==> web build"
[ -d node_modules ] || npm ci
# @sentry/browser is not in upstream's package.json on purpose: --no-save
# leaves both package.json and package-lock.json untouched, and letting npm
# read the lock file keeps transitive pins like @swc/core intact (a newer
# @swc/core breaks vite-plugin-top-level-await).
npm install --no-save --no-audit --no-fund "@sentry/browser@${SENTRY_SDK_VERSION:-10.27.0}"
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
cp "$ROOT/config.json" config.json
python3 "$ROOT/apply-noise.py" --dist cinny/dist --noise "$ROOT/noise"

echo "==> tauri shell deps"
[ -d node_modules ] || npm ci

# linuxdeploy bundles an old binutils whose strip cannot read .relr.dyn sections
# produced by current toolchains (Arch/CachyOS, deb13). Stripping is cosmetic here,
# so disable it; without FUSE2 the AppImage tool has to extract itself first.
export NO_STRIP=1
export APPIMAGE_EXTRACT_AND_RUN=1

echo "==> installers"
# Windows can be produced from Linux via cargo-xwin + NSIS (experimental upstream):
#   CROSS=windows scripts/build.sh
if [ "${CROSS:-}" = "windows" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
  npm run tauri -- build --config "$OVERLAY" \
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
npm run tauri -- build --config "$OVERLAY" --bundles "$BUNDLES"

echo
echo "done:"
find src-tauri/target/release/bundle -maxdepth 2 -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.msi' -o -name '*.exe' -o -name '*.dmg' \) -printf '  %p (%s bytes)\n'
