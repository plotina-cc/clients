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
# Build counter appended to the Debian revision so successive builds are
# distinct versions (an apt repository cannot hold two packages that share a
# Version, and rollback needs the previous one).
PLOTINA_REVISION="${PLOTINA_REVISION##*.}"
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
import os

values = {
    "Vendor": "Plotina <thebob3r@gmail.com>",
    "Maintainer": "Plotina <thebob3r@gmail.com>",
    "Homepage": "https://plotina.cc",
}
revision = os.environ.get("PLOTINA_REVISION", "").strip()
match = re.search(r"^Version: *(\S+)", text, flags=re.M)
if match:
    version = match.group(1)
    # electron-builder emits a semver prerelease revision ("1.12.32~plotina.33");
    # a tilde sorts *below* every revision, which made apt prefer the previous
    # build. Normalise it to a Debian revision and never append twice.
    if "~plotina." in version:
        version = version.replace("~plotina.", "-plotina.")
    build = re.search(r"-plotina\.(\d+)$", version)
    if build:
        version = version[: build.start()] + "-plotina." + build.group(1)
    elif revision:
        version = f"{version}-plotina.{revision}"
    text = re.sub(r"^Version: *\S+", f"Version: {version}", text, count=1, flags=re.M)
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

# Opt-in guard for the Plotina Desktop build (REQUIRE_HICOLOR_ICONS=1): a
# single 512px icon leaves KDE/GNOME hunting for a size they can render
# crisply, so the build must ship the full hicolor set
# (16/24/32/48/64/128/256/512, packaged at build time via
# --config.linux.icon=icons — see element-desktop/build/icons/). The deb is
# re-hashed into latest-linux.yml after re-packing here anyway, so checking
# now is free. Cinny's lite debs are Tauri-packed and don't set the flag.
if [ "${REQUIRE_HICOLOR_ICONS:-0}" = "1" ]; then
  icon_count=$(find "$ROOT/pkg/usr/share/icons/hicolor" -path "*/apps/*.png" 2>/dev/null | wc -l)
  if [ "${icon_count:-0}" -lt 8 ]; then
    echo "fix-deb-branding: only $icon_count hicolor icon(s) in $DEB; expected >=8 sizes" >&2
    exit 1
  fi
fi

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
# Belt-and-braces only since the workflow switched to build-time
# --config.publish.* overrides: the yml already names plotina-cc/clients, this
# sed is a no-op. (We cannot re-pack the AppImage the same way: that would
# change the bytes behind the sha512 latest-linux.yml publishes for it.)
for update_yml in "$ROOT"/pkg/opt/*/resources/app-update.yml; do
  [ -f "$update_yml" ] || continue
  sed -i \
    -e 's/^owner:.*/owner: plotina-cc/' \
    -e 's/^repo:.*/repo: clients/' \
    "$update_yml"
done

# FPM writes upstream's maintainer into the changelog trailer; dpkg shows it
# in apt changelog output.
for changelog in "$ROOT"/pkg/usr/share/doc/*/changelog.gz; do
  [ -f "$changelog" ] || continue
  tmp="$changelog.tmp"
  gzip -dc "$changelog" \
    | sed 's/Element <support@element\.io>/Plotina <thebob3r@gmail.com>/g' \
    | gzip -9n > "$tmp" && mv "$tmp" "$changelog"
done

dpkg-deb -b -Zxz "$ROOT/pkg" "$DEB" >/dev/null
echo "fix-deb-branding: $DEB rewritten (Vendor/Maintainer/Homepage, Name)"
