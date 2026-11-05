#!/usr/bin/env python3
"""Render the Plotina in-app logo assets that FluffyChat ships in assets/logo/mini/.

Run manually whenever the brand geometry changes; the output is committed as
static PNGs under fluffychat/plotina_assets/ so CI and build-android.sh never
need Pillow — scripts/apply-plotina-app-assets.py only copies the PNGs.

Geometry source of truth: branding/icons/plotina-green.svg
(512-unit canvas, #17795A rounded rect rx=96, white path
"M128 128H384V384H320V192H192V384H128Z" = the П mark).
Everything is drawn at 4x and downsampled with LANCZOS for antialiasing.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "plotina_assets"
SS = 4  # supersampling factor
GREEN = (23, 121, 90)  # #17795A
WHITE = (255, 255, 255)

# The П mark as 512-space corner points (clockwise from top-left).
MARK_512 = [
    (128, 128),
    (384, 128),
    (384, 384),
    (320, 384),
    (320, 192),
    (192, 192),
    (192, 384),
    (128, 384),
]
MARK_MIN, MARK_MAX = 128, 384  # the mark fills 256/512 of the canvas, centred


def scaled_mark(canvas: int) -> list[tuple[float, float]]:
    """П points mapped from the 512 brand grid onto a square canvas.

    The mark keeps its brand proportion (half the canvas width/height) and
    stays centred: it spans canvas*0.25 .. canvas*0.75.
    """
    lo, hi = canvas * 0.25, canvas * 0.75
    span = hi - lo
    return [
        (lo + (x - MARK_MIN) / (MARK_MAX - MARK_MIN) * span,
         lo + (y - MARK_MIN) / (MARK_MAX - MARK_MIN) * span)
        for x, y in MARK_512
    ]


def downscale(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    return img.resize(size, Image.Resampling.LANCZOS)


def render_logo_mini(out: Path) -> None:
    """500x500: brand-green circle filling the canvas, white П centred.

    The corner pixels outside the circle stay transparent, so the square
    ClipRRect containers never show a corner.
    """
    s = 500 * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((0, 0, s - 1, s - 1), fill=GREEN + (255,))
    draw.polygon(scaled_mark(s), fill=WHITE + (255,))
    downscale(img, (500, 500)).save(out)


def render_logo_mono_mini(out: Path) -> None:
    """500x500: white П silhouette on fully transparent background.

    RGB is (255, 255, 255) everywhere and the shape lives only in the alpha
    channel, so Flutter's `Image.asset(color: …)` tint replaces the white
    cleanly on the empty and lock screens.
    """
    s = 500 * SS
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).polygon(scaled_mark(s), fill=255)
    alpha = downscale(mask, (500, 500))
    img = Image.new("RGBA", (500, 500), WHITE + (0,))
    img.putalpha(alpha)
    img.save(out)


def find_bold_font() -> Path | None:
    candidates = [
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/DejaVuSans-Bold.ttf",
    ]
    for path in candidates:
        p = Path(path)
        if p.is_file():
            return p
    hits = sorted(Path("/usr/share/fonts").rglob("DejaVuSans-Bold.ttf"))
    return hits[0] if hits else None


def render_banner(out: Path) -> None:
    """1000x334 solid brand-green banner: white П + bold 'Plotina' wordmark.

    Falls back to a centred mark alone when no usable DejaVu Bold is found.
    The rectangle is full-bleed because show_update_snackbar.dart clips it
    with a ClipRRect of its own.
    """
    w, h = 1000, 334
    img = Image.new("RGBA", (w * SS, h * SS), GREEN + (255,))
    draw = ImageDraw.Draw(img)

    mark_h = int(h * 0.66)  # ~220 px tall in final size
    mark_w = mark_h  # the П bounding box is square in the brand grid
    gap = 44
    wordmark = "Plotina"
    font_path = find_bold_font()
    text_w = 0
    font = None
    if font_path is not None:
        # The wordmark must fit both under a cap of the mark height and in the
        # space left of the mark minus side margins, or the group overflows.
        target_h = int(mark_h * 0.62) * SS
        max_w = (w - mark_w - gap - 80) * SS
        for size in range(400, 40, -4):
            probe = ImageFont.truetype(str(font_path), size * SS)
            box = draw.textbbox((0, 0), wordmark, font=probe)
            if (box[3] - box[1]) <= target_h and (box[2] - box[0]) <= max_w:
                font = probe
                text_w = box[2] - box[0]
                break

    # text_w comes from the SS-scaled font; lay out in final pixels.
    total = mark_w + (gap + text_w / SS if font else 0)
    x = (w - total) / 2
    cy = h / 2
    draw.polygon(
        [(px * SS, py * SS) for px, py in scaled_mark_scaled(
            mark_h, offset_x=x, offset_y=cy - mark_h / 2)],
        fill=WHITE + (255,),
    )
    if font is not None:
        tx = (x + mark_w + gap) * SS + text_w // 2
        ty = cy * SS
        # textbbox top-left offset so "mm" centring is not skewed by bearings
        box = draw.textbbox((0, 0), wordmark, font=font)
        draw.text(
            (tx - (box[2] - box[0]) / 2 - box[0], ty - (box[3] - box[1]) / 2 - box[1]),
            wordmark,
            font=font,
            fill=WHITE + (255,),
        )
    downscale(img, (w, h)).save(out)


def scaled_mark_scaled(height: int, offset_x: float, offset_y: float):
    """The П polygon mapped to a given top-left origin and height."""
    return [
        (offset_x + (x - MARK_MIN) / (MARK_MAX - MARK_MIN) * height,
         offset_y + (y - MARK_MIN) / (MARK_MAX - MARK_MIN) * height)
        for x, y in MARK_512
    ]


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1].startswith("-"):
        raise SystemExit(
            "usage: render-plotina-app-assets.py [output-dir]\n"
            "renders logo_mini.png, logo_mono_mini.png and banner.png into "
            "fluffychat/plotina_assets/ (needs Pillow)."
        )
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    out_dir.mkdir(parents=True, exist_ok=True)
    render_logo_mini(out_dir / "logo_mini.png")
    render_logo_mono_mini(out_dir / "logo_mono_mini.png")
    render_banner(out_dir / "banner.png")
    for name in ("logo_mini.png", "logo_mono_mini.png", "banner.png"):
        p = out_dir / name
        print(f"rendered {p} ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
