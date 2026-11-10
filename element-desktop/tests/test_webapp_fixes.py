#!/usr/bin/env python3
"""Tests for the shared web fixes as consumed by Element Desktop.

Operator rule: EVERY fix the Element Web image ships (see
../element-web/webapp_fixes.py, imported by both branding scripts) must also
be present in the desktop webapp. These tests build a synthetic release
webapp (index.html with the noise pair apply-noise.py inserts,
bundles/<hash>/ with both custom-theme sheets at the live 133-use shape,
a minimal i18n tree) in a temp dir, run element-desktop/branding.py on it,
and assert each fix landed — plus a parity case that runs BOTH branding
entry points over identical CSS/HTML and requires byte-identical fix output.

    cd element-desktop && python3 -m unittest discover -s tests

stdlib only; no new dependencies.
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent
REPO = DESKTOP.parent
DESKTOP_BRANDING = DESKTOP / "branding.py"
WEB_BRANDING = REPO / "element-web" / "branding.py"
WEB_THEME_JS = REPO / "element-web" / "plotina-theme.js"
WEB_FIXES_PY = REPO / "element-web" / "webapp_fixes.py"
REPO_ICONS = REPO / "branding" / "icons"

BUNDLE = "7fef2be0ae8530458db3"
TIMELINE_BARE = "var(--timeline-text-color)"
TOKEN_START = "/* plotina-theme-tokens: legacy custom-theme tokens. */"
TOKEN_END = "/* end plotina-theme-tokens */"

# The legacy custom properties the pinned sheets use, with their real use
# shapes (see element-web/tests/branding_test.py for the annotated version and
# THEME-TOKENS.md for the decision table).
LEGACY_USES: dict[str, str | None] = {
    "--timeline-text-color": None,
    "--timeline-text-secondary-color": None,
    "--primary-color": None,
    "--roomlist-separator-color": None,
    "--roomlist-background-color": None,
    "--roomlist-highlights-color": None,
    "--sidebar-color": None,
    "--timeline-highlights-color": None,
    "--borderColor-muted": None,
    "--accent-color-300": None,
    "--borderColor-accent-emphasis": None,
    "--sidebar-color-50pct": None,
    "--timeline-text-color-50pct": None,
    "--accent-color-1000": None,
    "--accent-color-400": None,
    "--bgColor-danger-muted": None,
    "--fgColor-danger": None,
    "--secondary-hairline-color": None,
    "--timeline-background-color-50pct": None,
    "--secondary-content": "#2e2f32",
    "--accent-color": "#0dbd8b",
    "--quinary-content": "#6f7882",
    "--tertiary-content": "#2e2f32",
    "--alert": "#ff5b55",
    "--system": "#f4f6fa",
    "--quaternary-content": "#6f7882",
    "--links": "#0086e6",
    "--eventbubble-bg-hover": "#fafbfd",
    "--menu-selected-color": "#f5f8fa",
    "--strong-input-border-color": "#c7c7c7",
    "--eventbubble-others-bg": "#f4f6fa",
    "--eventbubble-self-bg": "#f0fbf8",
    "--focus-bg-color": "#ddd",
    "--timeline-background-color": "var(--cpd-color-bg-canvas-default)",
    "--icon-button-color": "var(--cpd-color-icon-tertiary)",
    "--other-user-pill-bg-color": "var(--cpd-color-bg-action-primary-rest)",
    "--font-family": "\"Nunito\",sans-serif",
    "--font-family-monospace": "\"Fira Code\",monospace",
    "--mx-image-reserved-height": "0",
    "--mx-line-clamp": "1",
}
LEGACY_DROPPED = ("--timeline-background-color", "--icon-button-color",
                  "--other-user-pill-bg-color")

# Compound tokens the definition block may reference; the fixture bundle.css
# declares exactly these so a value pointing at an absent token fails the audit.
CPD_TOKENS = (
    "--cpd-color-text-primary", "--cpd-color-text-secondary",
    "--cpd-color-text-critical-primary", "--cpd-color-text-action-accent",
    "--cpd-color-text-link-external", "--cpd-color-icon-tertiary",
    "--cpd-color-gray-300", "--cpd-color-gray-400", "--cpd-color-gray-500",
    "--cpd-color-gray-600", "--cpd-color-gray-700", "--cpd-color-gray-800",
    "--cpd-color-gray-900", "--cpd-color-gray-1200",
    "--cpd-color-green-300", "--cpd-color-green-400", "--cpd-color-green-1000",
    "--cpd-color-alpha-gray-300",
    "--cpd-color-bg-canvas-default", "--cpd-color-bg-subtle-primary",
    "--cpd-color-bg-subtle-secondary", "--cpd-color-bg-critical-subtle",
    "--cpd-color-border-interactive-primary",
    "--cpd-color-border-interactive-secondary",
    "--cpd-color-border-focused",
    "--cpd-color-bg-action-primary-rest",
)

NOISE_REL = ('<script src="noise/logic.js"></script>'
             '<script src="noise/boot.js" defer></script>')
NOISE_ABS = ('<script src="/noise/logic.js"></script>'
             '<script src="/noise/boot.js" defer></script>')
MODAL_OPEN = '<style id="plotina-modal-a11y">'
MODAL_RE = re.compile(r'<style id="plotina-modal-a11y">.*?</style>', re.S)
REL_TAG = '<script src="plotina-theme.js"></script>'
ABS_TAG = '<script src="/plotina-theme.js"></script>'
BUNDLE_SCRIPT = f'<script src="bundles/{BUNDLE}/bundle.js"></script>'
BUNDLE_CSS = f'<link rel="stylesheet" href="bundles/{BUNDLE}/bundle.css">'

# Stock v1.12.32-shaped index: metas in the attribute order both branding
# scripts match, icon links, bundle.css + theme-*-custom links, the noise
# pair exactly where apply-noise.py put it, loader last.
INDEX_TEMPLATE = """<!doctype html>
<html lang="en" style="height: 100%;">
  <head>
    <meta charset="utf-8">
    <title>Element</title>
    <link rel="apple-touch-icon" sizes="180x180" href="vector-icons/180.30b915f.png">
    <link rel="manifest" href="manifest.json">
    <link rel="icon" type="image/png" sizes="512x512" href="vector-icons/512.7ce350d.png">
    <meta name="apple-mobile-web-app-title" content="Element">
    <meta name="application-name" content="Element">
    <meta name="theme-color" content="#ffffff">
    <meta property="og:image" content="https://app.element.io/themes/element/img/logos/opengraph.png" />
    {bundle_css}
    <link rel="stylesheet" disabled="disabled" data-mx-theme="Light-custom" title="Light-custom" href="bundles/{bundle}/theme-light-custom.css">
    <link rel="stylesheet" disabled="disabled" data-mx-theme="Dark-custom" title="Dark-custom" href="bundles/{bundle}/theme-dark-custom.css">
    {noise}</head>
  <body style="height: 100%; margin: 0;">
    <noscript>Sorry, Element requires JavaScript to be enabled.</noscript>
    <div id="matrixchat" style="height: 100%;" class="notranslate"></div>
    {loader}
  </body>
</html>
"""

ERROR_VIEW_JS = (
    '(() => {const r=require("react");exports.ErrorView=()=>r.createElement("div",'
    '{className:"mx_ErrorView cpd-theme-light"},r.createElement("img",{className:'
    '"mx_ErrorView_logo",height:"160",src:"themes/element/img/logos/'
    'element-app-logo.png",alt:"Element"}),r.createElement("div",{className:'
    '"mx_ErrorView_container"},r.createElement("a",{href:"https://app.element.io"'
    ',alt:"Element web client"})));})();\n'
)

GREEN_SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#17795A"/></svg>\n'
GREEN_192 = b"\x89PNG\r\n\x1a\n fake plotina 192"
GREEN_512 = b"\x89PNG\r\n\x1a\n fake plotina 512"

# Upstream ru gaps reproduced: the three override keys are absent, shipped
# strings must survive verbatim.
RU_BEFORE = {
    "action": {"sign_out": "Удалить это устройство"},
    "encryption": {"verification": {"use_recovery_key": "Используйте recovery key"}},
}
RU_NAME = "ru.deadbeef.json"
EN_NAME = "en_EN.cafe123.json"


def custom_theme_css() -> str:
    """One rule per legacy token, in the shape the pinned sheets use it."""
    css = ("body{background-color:var(--timeline-background-color,"
           "var(--cpd-color-bg-canvas-default));border:0;color:"
           + TIMELINE_BARE + "}\n")
    # Upstream declares the emoji hook in :root of each custom sheet; the
    # legacy font stacks fall back to it.
    css += ':root{--emoji-font-family:""}\n'
    for name, fallback in LEGACY_USES.items():
        if name == "--timeline-text-color":
            continue
        value = f"var({name})" if fallback is None else f"var({name},{fallback})"
        css += f".mx_Legacy{name[2:].title().replace('-', '')}{{color:{value}}}\n"
    return css


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WebappFixture(unittest.TestCase):
    """A temp .build/webapp with the pieces the shared fixes require."""

    def make_webapp(self, root: Path, client: str) -> Path:
        """client='desktop': the apply-noise output branding.py consumes.
        client='web': the Dockerfile shape (absolute noise pair, COPYed
        assets) so the same tree can run through element-web/branding.py."""
        webapp = root / "webapp"
        bundle = webapp / "bundles" / BUNDLE
        bundle.mkdir(parents=True)
        noise = NOISE_REL if client == "desktop" else NOISE_ABS
        (webapp / "index.html").write_text(
            INDEX_TEMPLATE.format(bundle_css=BUNDLE_CSS, bundle=BUNDLE,
                                  noise=noise, loader=BUNDLE_SCRIPT),
            encoding="utf-8")
        (bundle / "bundle.js").write_text("// bundle\n", encoding="utf-8")
        (bundle / "error-view.js").write_text(ERROR_VIEW_JS, encoding="utf-8")
        for name in ("theme-light-custom.css", "theme-dark-custom.css"):
            (bundle / name).write_text(custom_theme_css(), encoding="utf-8")
        (bundle / "bundle.css").write_text(
            ":root{" + "".join(f"{token}:#123456;" for token in CPD_TOKENS)
            + "}\n", encoding="utf-8")
        self.builtin_sheet = bundle / "theme-light.css"
        self.builtin_sheet.write_text(
            "body{color:var(--cpd-color-text-primary)}\n", encoding="utf-8")

        logos = webapp / "themes" / "element" / "img" / "logos"
        logos.mkdir(parents=True)
        (logos / "element-app-logo.png").write_bytes(b"old-png")

        i18n = webapp / "i18n"
        i18n.mkdir()
        (i18n / "languages.json").write_text(
            json.dumps({"en": EN_NAME, "ru": RU_NAME}, indent=4) + "\n",
            encoding="utf-8")
        (i18n / RU_NAME).write_text(
            json.dumps(RU_BEFORE, ensure_ascii=False, indent=4) + "\n",
            encoding="utf-8")
        (i18n / EN_NAME).write_text(
            json.dumps({"action": {"sign_out_before_verify": "Sign out"}},
                       indent=4) + "\n", encoding="utf-8")
        self.en_before = (i18n / EN_NAME).read_bytes()

        guide = webapp / "mobile_guide"
        guide.mkdir()
        (guide / "index.html").write_text("<title>Element mobile guide</title>\n",
                                          encoding="utf-8")

        if client == "web":
            # The Dockerfile COPYs these before branding runs; the desktop
            # tree must NOT have them: branding.py copies plotina-theme.js
            # itself and gets the icons from --icons.
            shutil.copyfile(WEB_THEME_JS, webapp / "plotina-theme.js")
            shutil.copyfile(REPO / "element-web" / "plotina-dm-aliases.js",
                            webapp / "plotina-dm-aliases.js")
            shutil.copyfile(REPO_ICONS / "plotina-green.svg",
                            webapp / "plotina-icon.svg")
            shutil.copyfile(REPO_ICONS / "png" / "green-512.png",
                            webapp / "plotina-512.png")
            (logos / "element-logo.svg").write_text("<svg>OLD</svg>",
                                                    encoding="utf-8")
            (logos / "opengraph.png").write_bytes(b"old-og-png")
        else:
            self.icons = root / "icons"
            (self.icons / "png").mkdir(parents=True)
            (self.icons / "plotina-green.svg").write_bytes(GREEN_SVG)
            (self.icons / "png" / "green-192.png").write_bytes(GREEN_192)
            (self.icons / "png" / "green-512.png").write_bytes(GREEN_512)
        return webapp

    def run_desktop_branding(self, webapp: Path,
                             icons: Path | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(DESKTOP_BRANDING),
             "--webapp", str(webapp),
             "--icons", str(icons or self.icons)],
            capture_output=True, text=True)

    def run_web_branding(self, webapp: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(WEB_BRANDING), "--app", str(webapp)],
            capture_output=True, text=True)


class DesktopFixesTest(WebappFixture):
    """The four shared fixes as applied by element-desktop/branding.py."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="ed-webfixes-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.webapp = self.make_webapp(self.root, client="desktop")
        proc = self.run_desktop_branding(self.webapp)
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)

    def index(self) -> str:
        return (self.webapp / "index.html").read_text(encoding="utf-8")

    def sheet(self, name: str) -> str:
        return (self.webapp / "bundles" / BUNDLE / name).read_text(encoding="utf-8")

    # -- fix 1: legacy custom-theme tokens (THEME-TOKENS.md) -------------------
    def test_both_sheets_get_the_token_block(self) -> None:
        for name in ("theme-light-custom.css", "theme-dark-custom.css"):
            with self.subTest(sheet=name):
                css = self.sheet(name)
                self.assertEqual(css.count(TOKEN_START), 1)
                self.assertEqual(css.count(TOKEN_END), 1)
                self.assertIn("--timeline-text-color:"
                              "var(--cpd-color-text-primary);", css)
                self.assertIn("--roomlist-separator-color:transparent;", css)

    def test_no_bare_use_of_an_undefined_legacy_token(self) -> None:
        for name in ("theme-light-custom.css", "theme-dark-custom.css"):
            with self.subTest(sheet=name):
                css = self.sheet(name)
                declared = set(re.findall(r"(--[A-Za-z0-9_-]+)\s*:", css))
                for token in LEGACY_USES:
                    if f"var({token})" in css:
                        self.assertIn(token, declared, msg=f"{token} bare")

    def test_dropped_indirections_keep_their_fallback(self) -> None:
        css = self.sheet("theme-light-custom.css")
        for token in LEGACY_DROPPED:
            self.assertNotIn(f"var({token},", css)
        self.assertIn("body{background-color:var(--cpd-color-bg-canvas-default)",
                      css)

    def test_dark_overrides_differ(self) -> None:
        self.assertIn("--menu-selected-color:#f5f8fa;",
                      self.sheet("theme-light-custom.css"))
        self.assertIn("--menu-selected-color:#343a46;",
                      self.sheet("theme-dark-custom.css"))

    def test_other_uses_survive(self) -> None:
        # branding.py does not own the non-custom sheets.
        self.assertEqual(
            self.builtin_sheet.read_bytes(),
            b"body{color:var(--cpd-color-text-primary)}\n")

    # -- fix 2: plotina-modal-a11y -------------------------------------------
    def test_modal_style_once_after_the_theme_links(self) -> None:
        html = self.index()
        self.assertEqual(html.count(MODAL_OPEN), 1)
        self.assertIn(".mx_AuthPage_modalContent>.mx_Dialog_border"
                      "{max-height:calc(100vh - 150px)}", html)
        self.assertIn(".mx_CompleteSecurityBody{overflow-y:auto}", html)
        # After bundle.css/theme-*.css (equal-specificity cascade) and
        # without splitting the noise pair the tags must stay byte-identical.
        self.assertLess(html.index(f"bundles/{BUNDLE}/bundle.css"),
                        html.index(MODAL_OPEN))
        self.assertLess(html.index('href="bundles/'
                                   f'{BUNDLE}/theme-dark-custom.css'),
                        html.index(MODAL_OPEN))
        self.assertLess(html.index(MODAL_OPEN), html.index(NOISE_REL))
        self.assertEqual(html.count(NOISE_REL), 1)

    def test_modal_style_has_no_margin_rule(self) -> None:
        # Regression guard: stock .mx_AuthPage_modal `margin:100px auto auto`
        # keeps the auto bottom margin that pins the auth footer gradient to
        # the viewport bottom; an explicit margin glues it to the card.
        html = self.index()
        self.assertNotIn(".mx_AuthPage_modal{", html)
        self.assertNotIn("margin-bottom", html)

    # -- fix 3: plotina-theme.js bootstrap (relative on desktop) ------------
    def test_theme_script_copied_and_referenced_relatively(self) -> None:
        payload = self.webapp / "plotina-theme.js"
        self.assertTrue(payload.is_file())
        self.assertEqual(payload.read_bytes(), WEB_THEME_JS.read_bytes())
        html = self.index()
        self.assertEqual(html.count(REL_TAG), 1)
        self.assertNotIn(ABS_TAG, html)
        # Runs first: the tag sits directly in front of the bundle loader.
        self.assertIn(REL_TAG + BUNDLE_SCRIPT, html)

    # -- fix 4: ru locale fills ----------------------------------------------
    def test_missing_strings_added(self) -> None:
        ru = json.loads((self.webapp / "i18n" / RU_NAME).read_text(encoding="utf-8"))
        self.assertEqual(ru["action"]["sign_out_before_verify"], "Выйти")
        ver = ru["encryption"]["verification"]
        self.assertIn("no_other_devices", ver)
        self.assertIn("no_recovery_key", ver)
        self.assertTrue(ver["no_other_devices"].startswith("Этот параметр"))

    def test_existing_translations_survive(self) -> None:
        ru = json.loads((self.webapp / "i18n" / RU_NAME).read_text(encoding="utf-8"))
        self.assertEqual(ru["action"]["sign_out"], "Удалить это устройство")
        self.assertEqual(ru["encryption"]["verification"]["use_recovery_key"],
                         "Используйте recovery key")
        en = self.webapp / "i18n" / EN_NAME
        self.assertEqual(en.read_bytes(), self.en_before)

    # -- strictness: a broken webapp must fail the build ----------------------
    def test_missing_custom_sheet_fails_loudly(self) -> None:
        (self.webapp / "bundles" / BUNDLE / "theme-dark-custom.css").unlink()
        proc = self.run_desktop_branding(self.webapp)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("theme-*-custom.css", proc.stderr)

    def test_truncated_custom_sheet_fails_loudly(self) -> None:
        # A sheet that lost the legacy shape (or a new undefined variable) must
        # abort the build, not ship half-fixed CSS.
        (self.webapp / "bundles" / BUNDLE / "theme-light-custom.css").write_text(
            ".mx_A{color:var(--brand-new-dead-token)}\n", encoding="utf-8")
        proc = self.run_desktop_branding(self.webapp)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("legacy custom-theme tokens", proc.stderr)

    def test_missing_locale_file_fails_loudly(self) -> None:
        (self.webapp / "i18n" / RU_NAME).unlink()
        proc = self.run_desktop_branding(self.webapp)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(RU_NAME, proc.stderr)

    def test_moved_bundle_loader_fails_loudly(self) -> None:
        html = self.index().replace(BUNDLE_SCRIPT, '<script src="bundle.js"></script>')
        (self.webapp / "index.html").write_text(html, encoding="utf-8")
        proc = self.run_desktop_branding(self.webapp)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("bundle.js", proc.stderr)

    # -- idempotence ------------------------------------------------------------
    def test_second_run_is_byte_stable(self) -> None:
        paths = [self.webapp / "index.html",
                 self.webapp / "plotina-theme.js",
                 self.webapp / "plotina-dm-aliases.js",
                 self.webapp / "i18n" / RU_NAME]
        paths += [self.webapp / "bundles" / BUNDLE / n
                  for n in ("theme-light-custom.css", "theme-dark-custom.css")]
        before = [p.read_bytes() for p in paths]
        proc = self.run_desktop_branding(self.webapp)
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        self.assertEqual([p.read_bytes() for p in paths], before)

    def test_desktop_branding_still_owns_its_shell(self):
        # The pre-existing desktop work must survive the fix port.
        html = self.index()
        self.assertIn("<title>Plotina Desktop</title>", html)
        self.assertIn('src:"plotina-512.png"',
                      (self.webapp / "bundles" / BUNDLE / "error-view.js")
                      .read_text(encoding="utf-8"))
        self.assertFalse((self.webapp / "mobile_guide").exists())


class ParityTest(WebappFixture):
    """The regression guard for the operator rule.

    Identical CSS/HTML/i18n go through BOTH entry points — element-web's
    branding.py and element-desktop's branding.py — and every artefact the
    shared module produces must come out byte-identical. The only allowed
    divergence is the bootstrap tag form (absolute src on web, relative on
    desktop) because vector://vector/webapp/ does not serve root paths.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="ed-parity-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.web_tree = self.make_webapp(self.root / "web", client="web")
        self.desktop_tree = self.make_webapp(self.root / "desktop",
                                             client="desktop")
        self.brand_both()

    def brand_both(self) -> None:
        web = self.run_web_branding(self.web_tree)
        self.assertEqual(web.returncode, 0, msg=web.stdout + web.stderr)
        desk = self.run_desktop_branding(self.desktop_tree,
                                         icons=REPO_ICONS)
        self.assertEqual(desk.returncode, 0, msg=desk.stdout + desk.stderr)

    def test_identical_css_input_identical_css_output(self) -> None:
        sheets = [Path("bundles") / BUNDLE / n
                  for n in ("theme-light-custom.css", "theme-dark-custom.css")]
        for rel in sheets:
            with self.subTest(sheet=rel.name):
                a = (self.web_tree / rel).read_bytes()
                b = (self.desktop_tree / rel).read_bytes()
                self.assertEqual(a, b)
                self.assertIn(TOKEN_START.encode(), a)
                self.assertIn(b"--timeline-text-color:"
                              b"var(--cpd-color-text-primary);", a)

    def test_identical_locale_output(self) -> None:
        a = (self.web_tree / "i18n" / RU_NAME).read_bytes()
        b = (self.desktop_tree / "i18n" / RU_NAME).read_bytes()
        self.assertEqual(a, b)
        self.assertIn(b"sign_out_before_verify", a)

    def test_modal_block_identical_and_once_in_each(self) -> None:
        blocks = []
        for tree in (self.web_tree, self.desktop_tree):
            html = (tree / "index.html").read_text(encoding="utf-8")
            found = MODAL_RE.findall(html)
            self.assertEqual(len(found), 1, msg=str(tree))
            blocks.append(found[0])
        self.assertEqual(blocks[0], blocks[1])

    def test_theme_bootstrap_same_payload_first_in_both(self) -> None:
        # Same payload bytes, both loaded directly before the bundle loader;
        # the one intended difference is the src form (vector:// needs
        # relative paths, the web site root makes absolute ones correct).
        for tree, tag, other in ((self.web_tree, ABS_TAG, REL_TAG),
                                 (self.desktop_tree, REL_TAG, ABS_TAG)):
            with self.subTest(tree=tree.name):
                payload = tree / "plotina-theme.js"
                self.assertEqual(payload.read_bytes(), WEB_THEME_JS.read_bytes())
                html = (tree / "index.html").read_text(encoding="utf-8")
                self.assertEqual(html.count(tag), 1)
                self.assertEqual(html.count(other), 0)
                self.assertIn(tag + BUNDLE_SCRIPT, html)

    def test_dm_alias_overlay_same_payload_both_clients(self) -> None:
        # SPIKE-dm-aliases.md: one payload for both clients, tagged once in
        # each, and only the src form differs (vector:// needs it relative).
        rel = '<script src="plotina-dm-aliases.js" defer></script>'
        abs_ = '<script src="/plotina-dm-aliases.js" defer></script>'
        source = REPO / "element-web" / "plotina-dm-aliases.js"
        for tree, tag, other in ((self.web_tree, abs_, rel),
                                 (self.desktop_tree, rel, abs_)):
            with self.subTest(tree=tree.name):
                payload = tree / "plotina-dm-aliases.js"
                self.assertEqual(payload.read_bytes(), source.read_bytes())
                html = (tree / "index.html").read_text(encoding="utf-8")
                self.assertEqual(html.count(tag), 1)
                self.assertEqual(html.count(other), 0)
                self.assertIn(tag + "</head>", html)

    def test_both_scripts_consume_the_same_module(self) -> None:
        # Not two copies of the logic: both branding scripts resolve the SAME
        # webapp_fixes module object, so a fix applied on one client is by
        # construction the fix applied on the other.
        web = load_module("web_branding", WEB_BRANDING)
        desk = load_module("desktop_branding", DESKTOP_BRANDING)
        self.assertIs(web.webapp_fixes, desk.webapp_fixes)
        self.assertIs(web.rebrand_theme_custom,
                      desk.webapp_fixes.patch_theme_css)
        self.assertIs(web.rebrand_locales, desk.webapp_fixes.apply_locales)
        self.assertEqual(web.MODAL_BLOCK, desk.webapp_fixes.MODAL_BLOCK)
        self.assertEqual(web.webapp_fixes.LEGACY_TOKEN_VALUES,
                         desk.webapp_fixes.LEGACY_TOKEN_VALUES)
        self.assertEqual(web.webapp_fixes.LEGACY_TOKEN_VALUES_DARK,
                         desk.webapp_fixes.LEGACY_TOKEN_VALUES_DARK)
        self.assertEqual(web.webapp_fixes.LEGACY_TOKEN_DROPPED,
                         desk.webapp_fixes.LEGACY_TOKEN_DROPPED)

    def test_shared_helpers_are_the_single_source(self) -> None:
        # Neither branding script may re-implement the fix text or the
        # fallback rewrite: these exact strings live only in webapp_fixes.py.
        for path in (WEB_BRANDING, DESKTOP_BRANDING,):
            src = path.read_text(encoding="utf-8")
            with self.subTest(module=path.parent.name):
                self.assertNotIn(
                    ".mx_AuthPage_modalContent>.mx_Dialog_border"
                    "{max-height:calc(100vh - 150px)}", src)
                self.assertNotIn(
                    '"var(--timeline-text-color,var(--cpd-color-text-primary))"',
                    src)
                self.assertNotIn('MODAL_CSS = (', src)
                self.assertNotIn('class BrandingError', src)


if __name__ == "__main__":
    unittest.main()
