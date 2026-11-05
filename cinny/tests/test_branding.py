"""Unit tests for cinny/branding.py (run: python3 -m unittest discover -s cinny/tests).

Covers the theme-default guard: Plotina Lite ships "follow the system theme"
(prefers-color-scheme, Dark/Light) as the default for fresh users, and the
guard pins that in the minified bundle so an upstream flip of
`useSystemTheme` cannot silently regress it. Fixtures are byte-faithful
excerpts of the pinned prod bundle, so the counters asserted here are the
counters branding.py sees against a real dist.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import branding  # noqa: E402
import fixtures  # noqa: E402


class ApplyThemeDefaultTests(unittest.TestCase):
    def test_regressed_default_is_flipped_to_system(self) -> None:
        out, hits = branding.apply_theme_default(fixtures.REGRESSED_SETTINGS_DEFAULTS)
        self.assertEqual(hits, 1)
        # The new default: system theme on.
        self.assertIn("useSystemTheme:!0", out)
        # And the previous default is gone, not shadowed.
        self.assertNotIn("useSystemTheme:!1", out)

    def test_pinned_prod_default_is_left_untouched(self) -> None:
        out, hits = branding.apply_theme_default(fixtures.PROD_SETTINGS_DEFAULTS)
        self.assertEqual(hits, 0)
        self.assertEqual(out, fixtures.PROD_SETTINGS_DEFAULTS)
        self.assertIn("useSystemTheme:!0", out)

    def test_theme_resolution_is_not_rewritten(self) -> None:
        # The guard owns only the default; the Dark/Light fallback logic
        # (`?? Z3`, `?? bF`) in useActiveTheme must survive byte for byte,
        # both when the bundle is already on and when it is flipped.
        src = fixtures.PROD_SETTINGS_DEFAULTS + "," + fixtures.PROD_ACTIVE_THEME
        out, hits = branding.apply_theme_default(src)
        self.assertEqual((out, hits), (src, 0))
        self.assertIn("??Z3", out)
        self.assertIn("??bF", out)

        regressed = src.replace("useSystemTheme:!0", "useSystemTheme:!1")
        out2, hits2 = branding.apply_theme_default(regressed)
        self.assertEqual(hits2, 1)
        self.assertIn("useSystemTheme:!0", out2)
        self.assertNotIn("useSystemTheme:!1", out2)
        self.assertIn("??Z3", out2)
        self.assertIn("??bF", out2)

    def test_bundle_without_settings_default_raises(self) -> None:
        # A renamed/restructured upstream must abort the build, not pass
        # silently with an unpinned default.
        with self.assertRaises(ValueError):
            branding.apply_theme_default(fixtures.NO_DEFAULTS_BUNDLE)


class PinSystemThemeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dist = Path(self.tmp.name)
        (self.dist / "assets").mkdir()
        self.addCleanup(self.tmp.cleanup)

    def _write_chunk(self, name: str, body: str) -> Path:
        path = self.dist / "assets" / name
        path.write_text(body, encoding="utf-8")
        return path

    def test_flips_regressed_bundle_in_place(self) -> None:
        chunk = self._write_chunk("index-TESTTEST.js", fixtures.REGRESSED_SETTINGS_DEFAULTS)
        self._write_chunk("vendor-OTHER.js", fixtures.NO_DEFAULTS_BUNDLE)
        hits = branding.pin_system_theme(self.dist)
        self.assertEqual(hits, 1)
        out = chunk.read_text(encoding="utf-8")
        self.assertIn("useSystemTheme:!0", out)
        self.assertNotIn("useSystemTheme:!1", out)

    def test_pinned_bundle_needs_no_rewrite(self) -> None:
        chunk = self._write_chunk("index-DoOJk9D-.js", fixtures.PROD_SETTINGS_DEFAULTS)
        hits = branding.pin_system_theme(self.dist)
        self.assertEqual(hits, 0)
        self.assertEqual(chunk.read_text(encoding="utf-8"), fixtures.PROD_SETTINGS_DEFAULTS)

    def test_missing_defaults_abort_the_run(self) -> None:
        self._write_chunk("index-TESTTEST.js", fixtures.NO_DEFAULTS_BUNDLE)
        with self.assertRaises(SystemExit):
            branding.pin_system_theme(self.dist)


if __name__ == "__main__":
    unittest.main()
