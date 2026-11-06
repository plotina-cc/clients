#!/usr/bin/env bash
# Generate the packaged icon set for Plotina Lite Desktop (Electron).
#
# Master source: branding/icons/plotina-black.svg (the black/graphite Cinny
# mark; user-confirmed brand). The script asserts the render matches the
# raster already shipped in cinny/icons/icon.png (same mark, sub-2% pixel
# diff) so both "sources of truth" stay honest.
#
# Outputs (all under cinny-electron/build/, committed after generation):
#   icons/{16,24,32,48,64,128,256,512}x*.png   RGBA, hicolor sizes for deb/rpm/AppImage
#   icon.png                                   512 px (electron-builder app icon)
#   icon.ico                                    16..256 px multi-size (Windows)
# The BrowserWindow icon is capped at 128 px at runtime (src/main.js),
# because a 256+ px _NET_WM_ICON payload exceeds the X protocol request limit
# and KDE then shows a generic icon (element-desktop/desktop/icon.ts lesson).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
SVG="$REPO/branding/icons/plotina-black.svg"
RASTER="$REPO/cinny/icons/icon.png"
OUT="$HERE/build"
SIZES=(16 24 32 48 64 128 256 512)

[ -f "$SVG" ] || { echo "missing $SVG" >&2; exit 1; }
mkdir -p "$OUT/icons"

for s in "${SIZES[@]}"; do
  rsvg-convert -w "$s" -h "$s" -b none "$SVG" -o "$OUT/icons/${s}x${s}.png"
done
cp "$OUT/icons/512x512.png" "$OUT/icon.png"

# Windows multi-size .ico
magick "$OUT/icons/16x16.png" "$OUT/icons/24x24.png" "$OUT/icons/32x32.png" \
  "$OUT/icons/48x48.png" "$OUT/icons/64x64.png" "$OUT/icons/128x128.png" \
  "$OUT/icons/256x256.png" "$OUT/icon.ico"

# Equivalence check against the shipped cinny/icons raster (512 px).
# NOTE: `magick compare` exits 1 when images differ at all (expected here:
# antialiased edges), so `|| true` keeps the metric without tripping pipefail.
diff_pct=$(magick compare -metric AE -fuzz 10% "$OUT/icons/512x512.png" "$RASTER" null: 2>&1 | head -1 || true)
total=$((512*512))
echo "compare AE vs cinny/icons/icon.png: ${diff_pct} of ${total} px"
awk -v d="$diff_pct" -v t="$total" 'BEGIN { if (d/t > 0.02) { print "brand mismatch: >2% pixels differ" > "/dev/stderr"; exit 1 } }'

# Sanity: every PNG has the expected dimensions and carries alpha
# (ImageMagick reports the render as `srgba 4.0`).
for s in "${SIZES[@]}"; do
  desc=$(identify -format "%w %h %[channels]" "$OUT/icons/${s}x${s}.png")
  [[ "$desc" == "$s $s "*rgba* ]] || { echo "bad icon $s: '$desc'" >&2; exit 1; }
done
identify "$OUT/icon.ico" >/dev/null
echo "icons OK: $(ls "$OUT/icons" | tr '\n' ' ')"
