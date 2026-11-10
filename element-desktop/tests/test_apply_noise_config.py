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
    """The call widget is no longer upstream's, so apply-noise must not patch it.

    element-desktop/scripts/element-call-widget.py replaces
    webapp/widgets/element-call/ with our own Element Call and writes the
    desktop noise tags into that document (../../noise/logic.js,
    plotina-dfn.js, plotina-panel.js). Appending WIDGET_TAG on top would load
    logic.js twice and add boot.js to a page whose microphone is already
    processed by plotina-dfn.js — a double initialization of the denoiser.
    apply-noise.py therefore only asserts the tags are there.
    """

    def _widget(self, tmp: str, *, tags: bool = True) -> Path:
        widget = Path(tmp) / "index.html"
        body = "".join(apply_noise.WIDGET_TAGS) if tags else ""
        widget.write_text(
            f'<html><head><script>window.__plotinaEc=true;</script>{body}</head><body></body></html>',
            encoding="utf-8",
        )
        return widget

    def test_widget_keeps_exactly_one_copy_of_each_tag(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            widget = self._widget(tmp)
            before = widget.read_text(encoding="utf-8")
            apply_noise.patch_widget(widget)
            after = widget.read_text(encoding="utf-8")
            self.assertEqual(before, after)
            self.assertEqual(after.count("noise/plotina-dfn.js"), 1)
            self.assertEqual(after.count("noise/plotina-panel.js"), 1)
            self.assertNotIn("noise/boot.js", after)

    def test_widget_without_the_tags_fails_the_build(self) -> None:
        """A widget that lost its tags would run with the browser's own (weaker)
        noise suppression and no level panel — fail instead of shipping it."""
        with tempfile.TemporaryDirectory() as tmp:
            widget = self._widget(tmp, tags=False)
            with self.assertRaises(SystemExit) as ctx:
                apply_noise.patch_widget(widget)
            self.assertNotEqual(ctx.exception.code, 0)

    def test_widget_tags_are_relative_for_vector(self) -> None:
        """vector://vector/webapp/ never serves a root-absolute path."""
        for tag in apply_noise.WIDGET_TAGS:
            self.assertIn('src="../../noise/', tag)
            self.assertNotIn('src="/noise/', tag)
        self.assertFalse(any("boot.js" in tag for tag in apply_noise.WIDGET_TAGS))


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
