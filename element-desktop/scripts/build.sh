#!/usr/bin/env bash
# Build Plotina's Element Desktop from a pinned element-web tag.
#
#   scripts/build.sh            # current platform: AppImage+deb, or NSIS on Windows
#
# Expects: node 24 with pnpm, python3, git, curl, and network access for
# `pnpm install` and the Element Web release tarball (53 MB, cached in .build/).
# macOS is not built: our builds are unsigned and the arm64 runner would only
# cover Apple Silicon.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
WORK="${WORK:-$ROOT/.build}"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"
REPO="https://github.com/element-hq/element-web.git"
SRC="$WORK/element-web"

echo "==> upstream $TAG in $WORK"
mkdir -p "$WORK"
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$TAG" "$REPO" "$SRC"
fi
cd "$SRC"
git fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG" 2>/dev/null || true
git checkout --quiet "$TAG"

# The desktop app is part of the element-web monorepo since 1.12.14; only its
# own workspace project is installed, the webapp comes from the pinned tarball.
echo "==> desktop deps"
cd apps/desktop
pnpm install --frozen-lockfile --filter element-desktop

echo "==> webapp"
"$ROOT/scripts/prepare-webapp.sh" --dest "$WORK/webapp"

echo "==> webapp.asar"
rm -rf webapp webapp.asar
cp -a "$WORK/webapp" webapp
pnpm run asar-webapp
pnpm exec asar list webapp.asar | grep -q '^/noise/boot.js$'

echo "==> variant"
cp "$ROOT/build.plotina.json" variant.json

echo "==> installers"
# electron-builder#5721: hard links break the build inside some containers.
export USE_HARD_LINKS=false
case "$(uname -s)" in
  Linux)                TARGETS=(-l appimage deb) ;;
  MINGW*|MSYS*|CYGWIN*) TARGETS=(-w nsis) ;;
  *)
    echo "build.sh: unsupported platform $(uname -s); macOS is not built for lack of a signing identity" >&2
    exit 1
    ;;
esac
VARIANT_PATH=variant.json pnpm run build --publish never "${TARGETS[@]}"

echo "==> stable names"
mkdir -p "$ROOT/dist-stable"
shopt -s nullglob
for f in dist/*.AppImage; do cp "$f" "$ROOT/dist-stable/Plotina-Element.AppImage"; done
for f in dist/*.deb;      do cp "$f" "$ROOT/dist-stable/Plotina-Element.deb"; done
for f in dist/*.exe;      do cp "$f" "$ROOT/dist-stable/Plotina-Element-setup.exe"; done
ls -lh "$ROOT/dist-stable"
