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

echo "==> noise assets"
python3 "$ROOT/scripts/fetch-noise.py"

echo "==> web build"
cd cinny
[ -d node_modules ] || npm ci
npm run build

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
