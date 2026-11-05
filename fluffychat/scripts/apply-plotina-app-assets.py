#!/usr/bin/env python3
"""Copy the Plotina in-app logo assets over FluffyChat's mascot bitmaps.

Replaces assets/logo/mini/{logo_mini,logo_mono_mini,banner}.png in an upstream
checkout with the pre-rendered PNGs from fluffychat/plotina_assets/ (rendered
by scripts/render-plotina-app-assets.py; commit the PNGs, do not add a Pillow
dependency to CI). These paths are what the welcome/login screens
(intro_page.dart, login_view.dart, platform_infos.dart), the empty and lock
screens (empty_page.dart, lock_screen.dart, tinted through Image.asset
`color:`) and the update snackbar (show_update_snackbar.dart) already load,
so no code patch is needed.

Usage: apply-plotina-app-assets.py [path-to-upstream-checkout]
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]  # fluffychat/
ASSETS = REPO / "plotina_assets"
DEST_SUBDIR = Path("assets") / "logo" / "mini"
FILES = ("logo_mini.png", "logo_mono_mini.png", "banner.png")


def main() -> None:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else REPO / "upstream"
    dest_dir = root / DEST_SUBDIR
    if not dest_dir.is_dir():
        raise SystemExit(
            f"missing FluffyChat in-app logo directory: {dest_dir}\n"
            "clone upstream first (see scripts/build-android.sh) or pass the "
            "checkout path: apply-plotina-app-assets.py <upstream-clone>"
        )
    missing = [name for name in FILES if not (ASSETS / name).is_file()]
    if missing:
        raise SystemExit(
            "missing Plotina source assets in "
            f"{ASSETS}: {', '.join(missing)} — regenerate with "
            "scripts/render-plotina-app-assets.py"
        )
    for name in FILES:
        src = ASSETS / name
        dst = dest_dir / name
        shutil.copyfile(src, dst)
        print(f"replaced {dst} ({src.stat().st_size} bytes, from plotina_assets/{name})")
    print(f"replaced {len(FILES)} FluffyChat in-app logo assets")


if __name__ == "__main__":
    main()
