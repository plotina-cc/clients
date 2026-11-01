#!/usr/bin/env python3
"""Replace the Element X app-icon bitmaps with the provisional Plotina mark."""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = (
    Path(sys.argv[1]).resolve()
    if len(sys.argv) > 1
    else Path(__file__).resolve().parents[1]
)
BRAND = Path(__file__).resolve().parents[2] / "branding" / "icons" / "webp"
RES = ROOT / "appicon" / "element" / "src" / "main" / "res"

DENSITY = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}


def main() -> None:
    if not RES.is_dir():
        raise SystemExit(f"missing Element X appicon directory: {RES}")
    replaced = 0
    for name, size in DENSITY.items():
        source = BRAND / f"green-{size}.webp"
        if not source.is_file():
            raise SystemExit(f"missing brand icon: {source}")
        folder = RES / f"mipmap-{name}"
        for target in folder.glob("ic_launcher*.webp"):
            shutil.copyfile(source, target)
            replaced += 1
    print(f"replaced {replaced} Element X icon files")


if __name__ == "__main__":
    main()
