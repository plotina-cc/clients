#!/usr/bin/env bash
# Publish a GitHub release of this repository to the edge host.
#
#   scripts/publish-clients.sh v4.12.8-plotina.7
#
# The release is public, so no token is needed. Assets are installed under the
# stable names the join page links to, and the versioned names stay next to them
# so an already-printed URL keeps working after a bump. The join page itself
# lives in the infrastructure repository and is not touched here.
set -euo pipefail

TAG="${1:?usage: publish-clients.sh <tag>}"
REPO=plotina-cc/clients
EDGE=adman-edge
DEST=/srv/dl
BASE="https://github.com/$REPO/releases/download/$TAG"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# "<asset in the release> <stable name on the edge>"
ASSETS="
Plotina_4.12.8_x64-setup.exe Plotina-setup.exe
Plotina_4.12.8_amd64.AppImage Plotina.AppImage
Plotina_4.12.8_amd64.deb Plotina.deb
Plotina_4.12.8_x64_en-US.msi Plotina.msi
"

echo "==> скачиваю $TAG"
echo "$ASSETS" | while read -r asset stable; do
  [[ -z "$asset" ]] && continue
  curl -sSL --fail --max-time 900 -o "$WORK/$asset" "$BASE/$asset" \
    || { echo "нет ассета: $asset" >&2; exit 1; }
  cp "$WORK/$asset" "$WORK/$stable"
  printf '    %-32s %s\n' "$stable" "$(du -h "$WORK/$stable" | cut -f1)"
done

# rpm appears from -plotina.7 onwards
if curl -sSL --fail --max-time 900 -o "$WORK/Plotina.rpm" "$BASE/Plotina-4.12.8-1.x86_64.rpm" 2>/dev/null; then
  printf '    %-32s %s\n' "Plotina.rpm" "$(du -h "$WORK/Plotina.rpm" | cut -f1)"
else
  echo "    rpm в этом релизе нет, пропускаю"
fi

echo "==> кладу на $EDGE:$DEST"
tar -C "$WORK" -cf - . | ssh "$EDGE" 'mkdir -p /tmp/dlin && tar -xf - -C /tmp/dlin &&
  sudo install -d -m 755 /srv/dl &&
  sudo install -m 644 /tmp/dlin/* /srv/dl/ &&
  rm -rf /tmp/dlin && ls -lh /srv/dl'

echo "==> проверка отдачи"
for f in Plotina-setup.exe Plotina.AppImage Plotina.deb Plotina.rpm; do
  printf '%-22s ' "$f"
  curl -s -r 0-1023 -o /dev/null -w 'HTTP %{http_code} %{size_download}B %{content_type}\n' \
    --max-time 20 "https://plotina.cc/dl/$f"
done
