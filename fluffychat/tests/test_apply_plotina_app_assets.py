#!/usr/bin/env python3
"""Tests for the Plotina in-app logo assets and apply-plotina-app-assets.py.

Run: python3 -m unittest discover -s fluffychat/tests -v
Needs Pillow for the pixel checks; the subprocess tests run without it. CI
does not execute this file (it builds the APK) — it guards the committed
plotina_assets/ PNGs so a regeneration cannot silently ship a bad asset.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]  # fluffychat/
SCRIPT = REPO / "scripts" / "apply-plotina-app-assets.py"
ASSETS = REPO / "plotina_assets"
NAMES = ("logo_mini.png", "logo_mono_mini.png", "banner.png")

GREEN = (23, 121, 90)  # #17795A
WHITE = (255, 255, 255)

try:
    from PIL import Image
except ImportError:  # Pillow is optional here; pixel tests skip without it
    Image = None


def run_script(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def load_rgba(name: str):
    assert Image is not None  # callers guard with skipUnless below
    img = Image.open(ASSETS / name)
    img.load()
    return img


def pixels(img) -> bytes:
    """RGBA bytes, no deprecated getdata()."""
    return img.convert("RGBA").tobytes("raw", "RGBA")


class ApplyScriptTests(unittest.TestCase):
    def test_replaces_all_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            mini = root / "assets" / "logo" / "mini"
            mini.mkdir(parents=True)
            for name in NAMES:
                (mini / name).write_bytes(b"placeholder fluffy mascot")
            proc = run_script(str(root))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            for name in NAMES:
                self.assertEqual(
                    (mini / name).read_bytes(),
                    (ASSETS / name).read_bytes(),
                    f"{name} was not replaced with the Plotina asset",
                )
                self.assertIn(name, proc.stdout)

    def test_fails_on_missing_assets_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = run_script(tmp)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("assets/logo/mini", proc.stderr)
            # A failed run must not create anything in the checkout.
            self.assertEqual(list(Path(tmp).iterdir()), [])


@unittest.skipUnless(Image is not None, "Pillow not installed")
class PlotinaAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [n for n in NAMES if not (ASSETS / n).is_file()]
        if missing:
            raise AssertionError(
                f"plotina_assets/ is missing {missing}; run "
                "scripts/render-plotina-app-assets.py"
            )

    def test_pngs_decode(self):
        for name in NAMES:
            img = load_rgba(name)
            self.assertEqual(img.format, "PNG", name)
            self.assertGreater(img.size[0], 0)
            self.assertGreater(img.size[1], 0)

    def test_logo_mini_is_square_and_mostly_brand_green(self):
        img = load_rgba("logo_mini.png")
        self.assertEqual(img.size, (500, 500))
        data = pixels(img)
        for corner in ((0, 0), (499, 0), (0, 499), (499, 499)):
            self.assertEqual(
                data[(corner[1] * 500 + corner[0]) * 4 + 3],
                0,
                f"corner {corner} must be transparent (widget clips to a circle)",
            )
        opaque = green = white = 0
        for i in range(0, len(data), 4):
            r, g, b, a = data[i : i + 4]
            if a < 200:
                continue
            opaque += 1
            if all(abs(c - t) <= 20 for c, t in zip((r, g, b), GREEN)):
                green += 1
            elif min(r, g, b) > 235:
                white += 1
        self.assertGreater(opaque / (500 * 500), 0.70)  # circle fills the canvas
        self.assertGreater(green / opaque, 0.70)
        self.assertGreater(white / opaque, 0.05)  # the П mark is present
        # centred white bar of the П, inside the circle
        self.assertGreater(data[(150 * 500 + 250) * 4 + 3], 200)
        self.assertEqual(tuple(data[(150 * 500 + 250) * 4 : (150 * 500 + 250) * 4 + 3]), WHITE)

    def test_mono_mini_is_white_alpha_only_silhouette(self):
        img = load_rgba("logo_mono_mini.png")
        self.assertEqual(img.mode, "RGBA")
        self.assertEqual(img.size, (500, 500))
        data = pixels(img)
        for corner in ((0, 0), (499, 0), (0, 499), (499, 499)):
            self.assertEqual(
                data[(corner[1] * 500 + corner[0]) * 4 + 3], 0, "corners must be transparent"
            )
        visible = 0
        for i in range(0, len(data), 4):
            r, g, b, a = data[i : i + 4]
            if a:
                if a > 200:
                    self.assertEqual((r, g, b), WHITE, "opaque pixels must be pure white")
                visible += 1
        self.assertGreater(visible, 1000, "the П silhouette must actually be drawn")
        # between the legs there is nothing (alpha only, RGB stays white)
        self.assertEqual(data[(300 * 500 + 250) * 4 + 3], 0)

    def test_banner_expected_size_and_branding(self):
        img = load_rgba("banner.png")
        self.assertEqual(img.size, (1000, 334))
        data = pixels(img)
        green = white = 0
        for i in range(0, len(data), 4):
            r, g, b, a = data[i : i + 4]
            if a < 200:
                self.fail("banner must be a full-bleed rectangle (alpha everywhere)")
            if all(abs(c - t) <= 20 for c, t in zip((r, g, b), GREEN)):
                green += 1
            elif min(r, g, b) > 235:
                white += 1
            # first and last columns are untouched green (no clipped content)
        total = 1000 * 334
        self.assertGreater(green / total, 0.60)
        self.assertGreater(white / total, 0.03)  # mark + wordmark are present


if __name__ == "__main__":
    unittest.main()
