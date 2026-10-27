#!/usr/bin/env bash
# Wrap a cross-compiled cinny.exe into a per-user NSIS installer.
#
#   windows/build-installer.sh <path to cinny.exe> <version>
#
# Needs makensis (Arch: yay -S nsis, Debian: apt install nsis).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXE="${1:?usage: build-installer.sh <cinny.exe> <version>}"
VERSION="${2:?usage: build-installer.sh <cinny.exe> <version>}"

# NSIS resolves File relative to the script, so hand it an absolute path.
EXE="$(cd "$(dirname "$EXE")" && pwd)/$(basename "$EXE")"
OUT="$(pwd)/Plotina-${VERSION}-setup.exe"

makensis -V2 \
  -DVERSION="$VERSION" \
  -DEXENAME="$(basename "$EXE")" \
  -DEXEPATH="$EXE" \
  -DOUTFILE="$OUT" \
  "$HERE/installer.nsi"

echo "built: $OUT"
ls -lh "$OUT"
