#!/usr/bin/env bash
# Publish Cinny Desktop builds to the edge and refresh the join page.
#
#   scripts/publish-clients.sh /path/to/dir-with-builds <version>
#
# The directory must contain Plotina-<version>-setup.exe,
# Plotina-x86_64.AppImage and Plotina_<version>_amd64.deb.
# Stable names are what the join page links to; versioned copies stay next to
# them so an already-printed URL keeps working after a bump.
set -euo pipefail

SRC="${1:?usage: publish-clients.sh <build-dir> <version>}"
VERSION="${2:?usage: publish-clients.sh <build-dir> <version>}"
EDGE=adman-edge
DEST=/srv/dl
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SETUP="Plotina-${VERSION}-setup.exe"
APPIMAGE="Plotina-x86_64.AppImage"
DEB="Plotina_${VERSION}_amd64.deb"
for f in "$SETUP" "$APPIMAGE" "$DEB"; do
  [[ -f "$SRC/$f" ]] || { echo "нет файла: $SRC/$f" >&2; exit 1; }
done

tar -C "$SRC" -cf - "$SETUP" "$APPIMAGE" "$DEB" \
  | ssh "$EDGE" 'mkdir -p /tmp/dlin && tar -xf - -C /tmp/dlin'

ssh "$EDGE" "sudo install -d -m 755 $DEST && \
  sudo install -m 644 /tmp/dlin/$SETUP $DEST/Plotina-setup.exe && \
  sudo install -m 644 /tmp/dlin/$SETUP $DEST/$SETUP && \
  sudo install -m 644 /tmp/dlin/$APPIMAGE $DEST/Plotina.AppImage && \
  sudo install -m 644 /tmp/dlin/$APPIMAGE $DEST/Plotina-${VERSION}-x86_64.AppImage && \
  sudo install -m 644 /tmp/dlin/$DEB $DEST/Plotina.deb && \
  sudo install -m 644 /tmp/dlin/$DEB $DEST/$DEB && \
  rm -rf /tmp/dlin && ls -lh $DEST"

scp -q "$REPO/config/join/index.html" "$EDGE:/home/hermes/join-index.html"
ssh "$EDGE" "sudo cp -a /srv/join/index.html /srv/join/index.html.bak-\$(date +%Y%m%d-%H%M%S) && \
  sudo install -m 644 /home/hermes/join-index.html /srv/join/index.html && rm -f /home/hermes/join-index.html"

for f in Plotina-setup.exe Plotina.AppImage Plotina.deb; do
  printf '%-22s ' "$f"
  curl -s -r 0-1023 -o /dev/null -w 'HTTP %{http_code} %{size_download}B %{content_type}\n' \
    --max-time 20 "https://plotina.cc/dl/$f"
done
