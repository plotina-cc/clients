"""Config parity with the Element Web config.json.

The desktop shell serves the webapp from vector://vector/webapp/, so the
branding asset URLs that are root-absolute on chat.plotina.cc must become
relative here, and branding.py copies the two files they name into the webapp
root. Without this the auth header logo and the welcome background silently
404 on the desktop.
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location("apply_noise", ROOT / "apply-noise.py")
assert _spec and _spec.loader
apply_noise = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(apply_noise)


class WidgetNoisePatchTest(unittest.TestCase):
    def test_widget_gets_relative_noise_tags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            widget = Path(tmp) / "index.html"
            widget.write_text("<html><head></head><body></body></html>", encoding="utf-8")
            apply_noise.patch_html(widget, apply_noise.WIDGET_TAG)
            text = widget.read_text(encoding="utf-8")
            self.assertIn('src="../../noise/logic.js"', text)
            self.assertIn('src="../../noise/boot.js" defer', text)
            self.assertEqual(text.count("noise/boot.js"), 1)

    def test_widget_patch_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            widget = Path(tmp) / "index.html"
            widget.write_text("<html><head></head></html>", encoding="utf-8")
            apply_noise.patch_html(widget, apply_noise.WIDGET_TAG)
            apply_noise.patch_html(widget, apply_noise.WIDGET_TAG)
            self.assertEqual(widget.read_text(encoding="utf-8").count("noise/boot.js"), 1)


class BrandingPathsRelativeTest(unittest.TestCase):
    def test_strips_leading_slash(self) -> None:
        config = {
            "branding": {
                "logo_link_url": "https://plotina.cc",
                "welcome_background_url": "/plotina-bg.png",
                "auth_header_logo_url": "/plotina-icon.svg",
            }
        }
        changed = apply_noise.make_branding_paths_relative(config)
        self.assertEqual(config["branding"]["welcome_background_url"], "plotina-bg.png")
        self.assertEqual(config["branding"]["auth_header_logo_url"], "plotina-icon.svg")
        self.assertEqual(len(changed), 2)
        # Absolute links to other hosts are not asset paths and stay untouched.
        self.assertEqual(config["branding"]["logo_link_url"], "https://plotina.cc")

    def test_ignores_protocol_relative_and_https(self) -> None:
        config = {
            "branding": {
                "welcome_background_url": "//cdn.example.org/bg.png",
                "auth_header_logo_url": "https://plotina.cc/plotina-icon.svg",
            }
        }
        self.assertEqual(apply_noise.make_branding_paths_relative(config), [])
        self.assertEqual(config["branding"]["welcome_background_url"],
                         "//cdn.example.org/bg.png")

    def test_missing_branding_block(self) -> None:
        self.assertEqual(apply_noise.make_branding_paths_relative({}), [])

    def test_write_config_emits_relative_paths(self) -> None:
        source = {
            "sentry": {"dsn": "https://abc123@glitchtip.example.org/7",
                       "environment": "production"},
            "branding": {
                "logo_link_url": "https://plotina.cc",
                "welcome_background_url": "/plotina-bg.png",
                "auth_header_logo_url": "/plotina-icon.svg",
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "in.json"
            dst = Path(tmp) / "config.json"
            src.write_text(json.dumps(source), encoding="utf-8")
            apply_noise.write_config(src, dst, brand="Plotina Desktop")
            written = json.loads(dst.read_text(encoding="utf-8"))
        self.assertEqual(written["brand"], "Plotina Desktop")
        self.assertEqual(written["branding"]["welcome_background_url"], "plotina-bg.png")
        self.assertEqual(written["branding"]["auth_header_logo_url"], "plotina-icon.svg")


if __name__ == "__main__":
    unittest.main()
