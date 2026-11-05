#!/usr/bin/env bash
# Rewrite the Debian metadata electron-builder inherits from upstream's
# package.json (Vendor/Maintainer/Homepage were still Element, and the menu
# entry read "Plotina-Desktop"). electron-builder's linux.desktop/extraMetadata
# do not reach these fields in our variant config, so the built .deb is
# post-processed instead of trusting them.
#
#   scripts/fix-deb-branding.sh <file.deb>
#
# Runs after `pnpm run build` in CI and in scripts/build.sh; needs dpkg-deb
# (Ubuntu runners and Debian build hosts have it).
set -euo pipefail

DEB="${1:?usage: fix-deb-branding.sh <file.deb>}"
# PRODUCT_NAME controls the menu entry; the desktop and lite packages differ.
PRODUCT_NAME="${PRODUCT_NAME:-Plotina Desktop}"
[ -f "$DEB" ] || { echo "fix-deb-branding: $DEB not found" >&2; exit 1; }
command -v dpkg-deb >/dev/null 2>&1 || {
  echo "fix-deb-branding: dpkg-deb missing; cannot rewrite $DEB" >&2
  exit 1
}

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

dpkg-deb -R "$DEB" "$ROOT/pkg"

python3 - "$ROOT/pkg/DEBIAN/control" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
values = {
    "Vendor": "Plotina <support@plotina.cc>",
    "Maintainer": "Plotina <support@plotina.cc>",
    "Homepage": "https://plotina.cc",
}
for field, value in values.items():
    if re.search(rf"^{field}:", text, flags=re.M):
        text = re.sub(rf"^{field}:.*$", f"{field}: {value}", text, flags=re.M)
    else:
        text += f"{field}: {value}\n"
# Upstream's archive keyring is not ours and dpkg would warn on every install.
text = re.sub(r"^Recommends: element-io-archive-keyring\n", "", text, flags=re.M)
# electron-builder leaves the synopsis empty; apt shows a blank line otherwise.
text = re.sub(r"^Description: *\n", "Description: Matrix client for plotina.cc\n", text, flags=re.M)
path.write_text(text, encoding="utf-8")
PY

# The menu entry: electron-builder writes the executable name as Name.
for entry in "$ROOT/pkg/usr/share/applications/"*.desktop; do
  [ -f "$entry" ] || continue
  sed -i \
    -e "s/^Name=.*/Name=${PRODUCT_NAME}/" \
    -e 's/^Comment=.*/Comment=Matrix client for plotina.cc/' \
    "$entry"
done

# dpkg-deb 1.22 defaults to zstd, which Ubuntu 22.04's dpkg cannot read;
# keep the xz compression electron-builder used.
dpkg-deb -b -Zxz "$ROOT/pkg" "$DEB" >/dev/null
echo "fix-deb-branding: $DEB rewritten (Vendor/Maintainer/Homepage, Name)"
