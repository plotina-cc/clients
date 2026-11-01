#!/usr/bin/env python3
"""Replace FluffyChat launcher/splash bitmaps with the provisional Plotina icon."""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = (
    Path(sys.argv[1]).resolve()
    if len(sys.argv) > 1
    else Path(__file__).resolve().parents[1]
)
BRAND = Path(__file__).resolve().parents[2] / "branding" / "icons" / "png"
RES = ROOT / "android" / "app" / "src" / "main" / "res"

# Approximate Android density buckets.  A full-bleed icon is used for every
# layer (background, foreground and legacy launcher) until a dedicated
# adaptive-icon foreground exists.
DENSITY = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}


def nearest_icon(size: int) -> Path:
    available = sorted(
        (int(p.stem.split("-")[-1]), p) for p in BRAND.glob("purple-*.png")
    )
    return min(available, key=lambda item: abs(item[0] - size))[1]


def main() -> None:
    if not RES.is_dir():
        raise SystemExit(f"missing FluffyChat res directory: {RES}")
    replaced = 0
    for folder in RES.glob("*"):
        if not folder.is_dir():
            continue
        for name in DENSITY:
            if not folder.name.endswith(name):
                continue
            icon = nearest_icon(DENSITY[name])
            for target in folder.glob("*.png"):
                if (
                    target.name.startswith("ic_launcher")
                    or target.name in {"splash.png", "monochrome.png"}
                ):
                    shutil.copyfile(icon, target)
                    replaced += 1
    playstore = RES / "mipmap-xxxhdpi" / "ic_launcher-playstore.png"
    if playstore.is_file():
        shutil.copyfile(nearest_icon(512), playstore)
        replaced += 1
    print(f"replaced {replaced} FluffyChat icon files")


if __name__ == "__main__":
    main()
