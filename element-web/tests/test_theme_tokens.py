#!/usr/bin/env python3
"""Contract tests for the Plotina custom Compound themes in element-web/config.json.

Element 1.12 renders the chat through Matrix Compound design tokens (see
docs/theming.md upstream: the ``compound`` object of a custom theme may contain
overrides for any *semantic* Compound token). These tests pin that contract:

* both Plotina themes exist with the right ``is_dark`` flags;
* every theme carries a consistent readable set of semantic colour tokens —
  text, canvas, disabled canvas, subtle background, interactive border —
  plus the accent tokens that must never be dropped;
* every token *name* is one that actually exists in the Compound bundle
  served on chat.plotina.cc (verified 2026-11 by grepping --cpd-color-* over
  bundles/*/bundle.css of the live deployment; the allowlist below is the
  evidence, so a future edit cannot invent a token name that silently does
  nothing);
* text-primary on the canvas meets WCAG AA (>= 4.5:1) in both themes.

Note there is no bare ``--cpd-color-bg-canvas`` token in Compound; the canvas
token is ``--cpd-color-bg-canvas-default``. The tests enforce the real name.

Run from the element-web directory:

    python3 tests/test_theme_tokens.py
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEBAPP = HERE.parent                      # element-web/
CONFIG = WEBAPP / "config.json"

LIGHT = "Plotina Mint"
DARK = "Plotina Mint Dark"

# Brand accents. Must match branding.py's theme-color and the product palette.
ACCENT_LIGHT = "#17795a"
ACCENT_DARK = "#7ee2b8"

# Semantic colour tokens every Plotina theme must pin. Names verified against
# the live Compound bundle (`:root,[class*=cpd-theme-]{...}` in bundle.css).
REQUIRED_TOKENS = [
    "--cpd-color-text-primary",
    "--cpd-color-text-secondary",
    "--cpd-color-bg-canvas-default",
    "--cpd-color-bg-canvas-disabled",
    "--cpd-color-bg-subtle-primary",
    "--cpd-color-border-interactive-secondary",
]

# Accent tokens shipped since the first rebrand; they must survive every edit.
ACCENT_TOKENS = [
    "--cpd-color-text-action-accent",
    "--cpd-color-icon-accent-tertiary",
    "--cpd-color-bg-action-primary-rest",
]

# Allowlist of token names that exist in the Compound bundle on chat.plotina.cc
# (the 96 semantic colour tokens declared in the `:root,[class*=cpd-theme-]`
# block of bundles/81bff4fd060173d686ec/bundle.css, extracted with grep). Any compound key outside this set is invented and dead CSS.
KNOWN_COMPOUND_TOKENS = {
    "--cpd-color-bg-accent-hovered",
    "--cpd-color-bg-accent-pressed",
    "--cpd-color-bg-accent-rest",
    "--cpd-color-bg-accent-selected",
    "--cpd-color-bg-action-primary-disabled",
    "--cpd-color-bg-action-primary-hovered",
    "--cpd-color-bg-action-primary-pressed",
    "--cpd-color-bg-action-primary-rest",
    "--cpd-color-bg-action-secondary-hovered",
    "--cpd-color-bg-action-secondary-pressed",
    "--cpd-color-bg-action-secondary-rest",
    "--cpd-color-bg-action-tertiary-hovered",
    "--cpd-color-bg-action-tertiary-rest",
    "--cpd-color-bg-action-tertiary-selected",
    "--cpd-color-bg-badge-accent",
    "--cpd-color-bg-badge-critical",
    "--cpd-color-bg-badge-default",
    "--cpd-color-bg-badge-info",
    "--cpd-color-bg-badge-primary",
    "--cpd-color-bg-badge-secondary",
    "--cpd-color-bg-canvas-default",
    "--cpd-color-bg-canvas-disabled",
    "--cpd-color-bg-critical-hovered",
    "--cpd-color-bg-critical-primary",
    "--cpd-color-bg-critical-subtle",
    "--cpd-color-bg-critical-subtle-hovered",
    "--cpd-color-bg-decorative-1",
    "--cpd-color-bg-decorative-2",
    "--cpd-color-bg-decorative-3",
    "--cpd-color-bg-decorative-4",
    "--cpd-color-bg-decorative-5",
    "--cpd-color-bg-decorative-6",
    "--cpd-color-bg-info-subtle",
    "--cpd-color-bg-subtle-primary",
    "--cpd-color-bg-subtle-secondary",
    "--cpd-color-bg-success-subtle",
    "--cpd-color-border-accent-primary",
    "--cpd-color-border-accent-subtle",
    "--cpd-color-border-critical-hovered",
    "--cpd-color-border-critical-primary",
    "--cpd-color-border-critical-subtle",
    "--cpd-color-border-disabled",
    "--cpd-color-border-focused",
    "--cpd-color-border-info-subtle",
    "--cpd-color-border-interactive-hovered",
    "--cpd-color-border-interactive-primary",
    "--cpd-color-border-interactive-secondary",
    "--cpd-color-border-success-subtle",
    "--cpd-color-gradient-critical-linear",
    "--cpd-color-gradient-critical-stop1",
    "--cpd-color-gradient-critical-stop2",
    "--cpd-color-gradient-info-linear",
    "--cpd-color-gradient-info-stop1",
    "--cpd-color-gradient-info-stop2",
    "--cpd-color-gradient-subtle-linear",
    "--cpd-color-gradient-subtle-stop1",
    "--cpd-color-gradient-subtle-stop2",
    "--cpd-color-gradient-subtle-stop3",
    "--cpd-color-gradient-subtle-stop4",
    "--cpd-color-gradient-subtle-stop5",
    "--cpd-color-gradient-subtle-stop6",
    "--cpd-color-icon-accent-primary",
    "--cpd-color-icon-accent-tertiary",
    "--cpd-color-icon-critical-primary",
    "--cpd-color-icon-disabled",
    "--cpd-color-icon-info-primary",
    "--cpd-color-icon-on-solid-primary",
    "--cpd-color-icon-primary",
    "--cpd-color-icon-primary-alpha",
    "--cpd-color-icon-quaternary",
    "--cpd-color-icon-quaternary-alpha",
    "--cpd-color-icon-secondary",
    "--cpd-color-icon-secondary-alpha",
    "--cpd-color-icon-success-primary",
    "--cpd-color-icon-tertiary",
    "--cpd-color-icon-tertiary-alpha",
    "--cpd-color-separator-primary",
    "--cpd-color-separator-secondary",
    "--cpd-color-text-action-accent",
    "--cpd-color-text-action-primary",
    "--cpd-color-text-badge-accent",
    "--cpd-color-text-badge-info",
    "--cpd-color-text-critical-primary",
    "--cpd-color-text-decorative-1",
    "--cpd-color-text-decorative-2",
    "--cpd-color-text-decorative-3",
    "--cpd-color-text-decorative-4",
    "--cpd-color-text-decorative-5",
    "--cpd-color-text-decorative-6",
    "--cpd-color-text-disabled",
    "--cpd-color-text-info-primary",
    "--cpd-color-text-link-external",
    "--cpd-color-text-on-solid-primary",
    "--cpd-color-text-primary",
    "--cpd-color-text-secondary",
    "--cpd-color-text-success-primary",
}

HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def load_config() -> dict:
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def custom_themes() -> dict[str, dict]:
    cfg = load_config()
    themes = cfg["setting_defaults"]["custom_themes"]
    return {t["name"]: t for t in themes}


def srgb_lin(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * srgb_lin(r) + 0.7152 * srgb_lin(g) + 0.0722 * srgb_lin(b)


def contrast_ratio(fg: str, bg: str) -> float:
    l1, l2 = sorted((relative_luminance(fg), relative_luminance(bg)),
                    reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)


class ThemePresenceTest(unittest.TestCase):
    def test_both_themes_defined(self) -> None:
        themes = custom_themes()
        for name in (LIGHT, DARK):
            self.assertIn(name, themes, msg=f"{name} missing from custom_themes")

    def test_is_dark_flags(self) -> None:
        themes = custom_themes()
        self.assertIs(themes[LIGHT]["is_dark"], False)
        self.assertIs(themes[DARK]["is_dark"], True)

    def test_default_theme_unchanged(self) -> None:
        cfg = load_config()
        self.assertEqual(cfg["default_theme"], f"custom-{LIGHT}")
        self.assertEqual(cfg["setting_defaults"]["theme"], f"custom-{LIGHT}")


class TokenCoverageTest(unittest.TestCase):
    def test_required_tokens_present(self) -> None:
        themes = custom_themes()
        for name, theme in themes.items():
            compound = theme.get("compound", {})
            for token in REQUIRED_TOKENS:
                with self.subTest(theme=name, token=token):
                    self.assertIn(
                        token, compound,
                        msg=f"{name} lacks {token}; theme would fall back to "
                            f"the stock Element palette for it")

    def test_accent_tokens_preserved(self) -> None:
        themes = custom_themes()
        expected = {LIGHT: ACCENT_LIGHT, DARK: ACCENT_DARK}
        for name, theme in themes.items():
            compound = theme["compound"]
            for token in ACCENT_TOKENS:
                with self.subTest(theme=name, token=token):
                    self.assertIn(token, compound)
                    self.assertEqual(
                        compound[token].lower(), expected[name],
                        msg=f"{name} lost its accent on {token}")
            # The legacy colour block must carry the same accent.
            self.assertEqual(theme["colors"]["accent-color"].lower(),
                             expected[name])
            self.assertEqual(theme["colors"]["primary-color"].lower(),
                             expected[name])

    def test_no_invented_token_names(self) -> None:
        """Every compound key must be a token the shipped bundle understands."""
        themes = custom_themes()
        for name, theme in themes.items():
            for token in theme.get("compound", {}):
                with self.subTest(theme=name, token=token):
                    self.assertIn(
                        token, KNOWN_COMPOUND_TOKENS,
                        msg=f"{token} is not a real Compound token in the "
                            f"chat.plotina.cc bundle")

    def test_values_are_hex_colors(self) -> None:
        themes = custom_themes()
        for name, theme in themes.items():
            for token in REQUIRED_TOKENS + ACCENT_TOKENS:
                with self.subTest(theme=name, token=token):
                    self.assertRegex(theme["compound"][token], HEX_RE)


class ReadabilityTest(unittest.TestCase):
    def test_text_on_canvas_contrast_aa(self) -> None:
        themes = custom_themes()
        for name, theme in themes.items():
            compound = theme["compound"]
            fg = compound["--cpd-color-text-primary"]
            bg = compound["--cpd-color-bg-canvas-default"]
            with self.subTest(theme=name):
                ratio = contrast_ratio(fg, bg)
                self.assertGreaterEqual(
                    ratio, 4.5,
                    msg=f"{name}: {fg} on {bg} is {ratio:.2f}:1, below WCAG AA")


if __name__ == "__main__":
    unittest.main()
