#!/usr/bin/env python3
"""Replace the Element X app-icon bitmaps with the Plotina mark.

Android adaptive icons are two layers: the background fills the 108dp canvas
and the launcher masks the middle ~72dp, while the foreground is drawn on the
same 108dp canvas. Copying our square tile into the foreground made the glyph
~75% of the visible circle and clipped it at the mask edge. The foreground now
carries only the white glyph, sized so it occupies half of the *visible* area,
exactly like the flat icons used by the web and the other clients.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = (
    Path(sys.argv[1]).resolve()
    if len(sys.argv) > 1
    else Path(__file__).resolve().parents[1]
)
BRAND = Path(__file__).resolve().parents[2] / "branding" / "icons" / "png"
RES = ROOT / "appicon" / "element" / "src" / "main" / "res"
RELEASE_RES = ROOT / "appicon" / "element" / "src" / "release" / "res"

DENSITY = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}
# Adaptive foreground canvas per density (108dp).
FOREGROUND = {
    "mdpi": 108,
    "hdpi": 162,
    "xhdpi": 216,
    "xxhdpi": 324,
    "xxxhdpi": 432,
}
BRAND_GREEN = "#17795A"


def white_glyph() -> Image.Image:
    """The white П alone, cropped to its bounding box, fully opaque."""
    source = Image.open(BRAND / "green-512.png").convert("RGBA")
    pixels = source.load()
    width, height = source.size
    min_x, min_y, max_x, max_y = width, height, 0, 0
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a > 40 and r > 200 and g > 200 and b > 200:
                min_x, min_y = min(min_x, x), min(min_y, y)
                max_x, max_y = max(max_x, x), max(max_y, y)
    if max_x <= min_x or max_y <= min_y:
        raise SystemExit("no white glyph found in the brand tile")
    crop = source.crop((min_x, min_y, max_x + 1, max_y + 1))
    glyph = Image.new("RGBA", crop.size, (255, 255, 255, 0))
    cpx = crop.load()
    gpx = glyph.load()
    for y in range(crop.height):
        for x in range(crop.width):
            r, g, b, a = cpx[x, y]
            if a > 40 and r > 200 and g > 200 and b > 200:
                gpx[x, y] = (255, 255, 255, 255)
    return glyph


def foreground_layer(glyph: Image.Image, size: int) -> Image.Image:
    """White glyph on a transparent 108dp canvas, at half the visible circle.

    The launcher shows only the middle 72dp of the 108dp layer, so size/3
    lands at 50% of the visible area — the same ratio as the flat tiles.
    """
    target = max(1, round(size / 3))
    scaled = glyph.resize((target, target), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(scaled, ((size - target) // 2, (size - target) // 2), scaled)
    return canvas


def circle_icon(tile: Image.Image, size: int) -> Image.Image:
    resized = tile.resize((size, size), Image.Resampling.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(resized, (0, 0), mask)
    return out


def main() -> None:
    if not RES.is_dir():
        raise SystemExit(f"missing Element X appicon directory: {RES}")

    tile = Image.open(BRAND / "green-512.png").convert("RGBA")
    glyph = white_glyph()
    replaced = 0
    for name, size in DENSITY.items():
        folder = RES / f"mipmap-{name}"
        flat = tile.resize((size, size), Image.Resampling.LANCZOS)
        for target in folder.glob("ic_launcher.webp"):
            flat.save(target, "WEBP", lossless=True)
            replaced += 1
        for target in folder.glob("ic_launcher_round.webp"):
            circle_icon(tile, size).save(target, "WEBP", lossless=True)
            replaced += 1
        layer = foreground_layer(glyph, FOREGROUND[name])
        for target in folder.glob("ic_launcher_foreground.webp"):
            layer.save(target, "WEBP", lossless=True)
            replaced += 1
        for target in folder.glob("ic_launcher_monochrome.webp"):
            layer.save(target, "WEBP", lossless=True)
            replaced += 1

    background = RELEASE_RES / "drawable" / "ic_launcher_background.xml"
    background.parent.mkdir(parents=True, exist_ok=True)
    background.write_text(
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:width="108dp"\n'
        '    android:height="108dp"\n'
        '    android:viewportWidth="108"\n'
        '    android:viewportHeight="108">\n'
        "    <path\n"
        f'        android:fillColor="{BRAND_GREEN}"\n'
        '        android:fillType="evenOdd"\n'
        '        android:pathData="m0,0h108v108h-108z" />\n'
        "</vector>\n",
        encoding="utf-8",
    )
    print(f"replaced {replaced} Element X icon files, background {BRAND_GREEN}")


if __name__ == "__main__":
    main()
