#!/usr/bin/env bash
# Repoint the updater inside a built AppImage at plotina-cc/clients.
#
# electron-builder writes resources/app-update.yml from upstream's publish
# block; the deb is fixed by fix-deb-branding.sh, but the AppImage embeds the
# same file in its squashfs. There is no supported way to edit it after the
# fact, so this extracts the AppImage (its runtime does that without FUSE),
# patches the yml, and re-packs the squashfs behind the original runtime.
#
#   scripts/fix-appimage-updater.sh <file.AppImage>
#
# Needs mksquashfs (squashfs-tools) and the AppImage's own --appimage-extract.
set -euo pipefail

APP="${1:?usage: fix-appimage-updater.sh <file.AppImage>}"
[ -f "$APP" ] || { echo "fix-appimage-updater: $APP not found" >&2; exit 1; }
command -v mksquashfs >/dev/null 2>&1 || {
  echo "fix-appimage-updater: mksquashfs missing (install squashfs-tools)" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

chmod +x "$APP"
(
  cd "$WORK"
  "$APP" --appimage-extract >/dev/null
)

YML="$WORK/squashfs-root/resources/app-update.yml"
if [ -f "$YML" ]; then
  sed -i \
    -e 's/^owner:.*/owner: plotina-cc/' \
    -e 's/^repo:.*/repo: clients/' \
    "$YML"
else
  echo "fix-appimage-updater: $APP has no resources/app-update.yml" >&2
  exit 1
fi

# Type-2 AppImages are <runtime ELF><squashfs>; the squashfs starts at the
# first 'hsqs' magic well past the runtime.
OFFSET=$(python3 - "$APP" <<'PY'
import sys

with open(sys.argv[1], "rb") as handle:
    head = handle.read(4 * 1024 * 1024)
index = head.find(b"hsqs", 32768)
print(index if index > 0 else -1)
PY
)
if [ "$OFFSET" -le 0 ]; then
  echo "fix-appimage-updater: could not locate the squashfs in $APP" >&2
  exit 1
fi

head -c "$OFFSET" "$APP" > "$WORK/runtime"
(
  cd "$WORK"
  mksquashfs squashfs-root app.squashfs -root-owned -noappend -comp zstd \
    -Xcompression-level 15 >/dev/null
)
cat "$WORK/runtime" "$WORK/app.squashfs" > "$APP.new"
chmod 755 "$APP.new"
mv "$APP.new" "$APP"
echo "fix-appimage-updater: $APP now checks plotina-cc/clients"
