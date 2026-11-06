#!/usr/bin/env bash
# fix-deb.sh — repack a built .deb with a dpkg-sortable Version.
#
# Why: electron-builder 26.16.1 hands fpm a version with every '-' replaced
# by '~' (LinuxTargetHelper.getSanitizedVersion), so APP_VERSION
# 4.12.8-plotina.18 lands as `Version: 4.12.8~plotina.18`. That sorts fine
# Electron->Electron, but '~' is BELOW the end-of-string in dpkg ordering,
# so such a deb reads as a DOWNGRADE against the plain 4.12.8 base and
# against the historic -plotina.N scheme (§6.1 invariant "dpkg sees .18 >
# .17"). Rewrite control to the hyphen form (upstream=4.12.8,
# revision=plotina.N), repack, keep every other byte.
#
# No dpkg-deb needed (works on Arch): a .deb is an `ar` archive of
# debian-binary + control.tar.xz + data.tar.xz.
#
#   bash scripts/fix-deb.sh path/to/Plotina-Lite-Desktop-*.deb
set -euo pipefail
deb="$1"
[ -f "$deb" ] || { echo "usage: fix-deb.sh file.deb" >&2; exit 1; }
deb="$(readlink -f "$deb")"   # we cd into temp dirs; keep the arg absolute
                               # (same trap fix-appimage-updater.sh learned)
case "$(basename "$deb")" in
  *plotina*) : ;;
  *) echo "fix-deb: $deb is not a plotina versioned deb, leaving as-is"; exit 0 ;;
esac

# Target version = the <version> part of the artifact name:
# Plotina-Lite-Desktop-<version>-<arch>.deb
base="$(basename "$deb")"
want_ver="$(echo "$base" | sed -E 's/^Plotina-Lite-Desktop-(.+)-[a-z0-9]+\.deb$/\1/')"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
( cd "$tmp" && ar x "$deb" )
ctrl="$(ls "$tmp"/control.tar.*)"
mkdir -p "$tmp/c"
( cd "$tmp/c" && tar -xf "../$(basename "$ctrl")" )
cur="$(grep '^Version:' "$tmp/c/control" | sed 's/^Version: //')"
newver="${cur//\~/-}"   # 4.12.8~plotina.18 -> 4.12.8-plotina.18
if [ "$newver" != "$want_ver" ]; then
  echo "fix-deb: unexpected version mapping: control='$cur' want='$want_ver'" >&2
  exit 1
fi
sed -i "s/^Version: .*/Version: $newver/" "$tmp/c/control"
# Repack control with stable mtimes/paths (tar members keep the leading ./).
( cd "$tmp/c" && tar cJf ../control.new.tar.xz --sort=name --mtime=@0 ./* )
( cd "$tmp" && rm "$(basename "$ctrl")" && mv control.new.tar.xz "$(basename "$ctrl")" )
out="$tmp/$(basename "$deb")"
( cd "$tmp" && ar rc "$out" debian-binary "$(basename "$ctrl")" "$(ls data.tar.*)" )
mv "$out" "$deb"
echo "fix-deb: $(basename "$deb") Version $cur -> $newver"
