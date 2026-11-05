#!/usr/bin/env python3
"""Tests for branding.py — the Plotina brand pass over the stock /app.

Run from the element-web directory:

    python3 -m unittest discover -s tests -p '*_test.py'

Each test lays out a throwaway copy of the upstream webapp (fixtures/ holds
the byte-exact index.html and error-view.js of the pinned v1.12.32, plus the
config.json baked into vectorim/element-web), runs branding.py on it and
asserts every brand replacement happened — and that nothing the brand pass
does not own (noise tags, other bundle chunks) was touched.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEBAPP = HERE.parent                      # element-web/
BRANDING = WEBAPP / "branding.py"
FIXTURES = HERE / "fixtures"
ROOT = WEBAPP.parent                      # repository root

BUNDLE = "7fef2be0ae8530458db3"
# The two noise <script> tags as the Dockerfile inserts them: branding.py must
# find them already in place and leave them byte-identical.
NOISE_TAG = ('<script src="/noise/logic.js"></script>'
             '<script src="/noise/boot.js" defer></script>')


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class AppFixture(unittest.TestCase):
    """A temp /app built from the real upstream bytes."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="branding-test-")
        self.addCleanup(self._tmp.cleanup)
        self.app = Path(self._tmp.name) / "app"
        bundles = self.app / "bundles" / BUNDLE
        logos = self.app / "themes" / "element" / "img" / "logos"
        bundles.mkdir(parents=True)
        logos.mkdir(parents=True)

        html = (FIXTURES / "index.html").read_text(encoding="utf-8")
        # The Dockerfile inserts the noise overlay *before* branding runs.
        html = html.replace("</head>", NOISE_TAG + "</head>")
        (self.app / "index.html").write_text(html, encoding="utf-8")

        shutil.copyfile(FIXTURES / "error-view.js", bundles / "error-view.js")

        # A sibling chunk that carries Element branding we deliberately keep:
        # the built-in Element Call widget and the baked release literal.
        self.other_chunk = bundles / "6312.js"
        self.other_chunk.write_text(
            'release:"1.12.32";const s="Element Call";'
            'document.title=document.title||"Element";',
            encoding="utf-8")
        self.other_before = self.other_chunk.read_bytes()

        # The /app/noise/ payload must survive untouched as well.
        noise = self.app / "noise"
        noise.mkdir()
        (noise / "boot.js").write_text("// Element noise boot stub", encoding="utf-8")
        self.noise_before = (noise / "boot.js").read_bytes()

        shutil.copyfile(FIXTURES / "config.json", self.app / "config.json")

        # The /app/i18n tree, same shape as the shipped one: a
        # languages.json manifest pointing at hashed locale files. This ru
        # fixture reproduces the real upstream gaps for the after-new-login
        # verification dialog (no sign_out_before_verify, no no_other_devices,
        # no no_recovery_key) while carrying strings that must survive.
        i18n = self.app / "i18n"
        i18n.mkdir()
        self.ru_name = "ru.deadbeef.json"
        self.en_name = "en_EN.cafe123.json"
        ru = {
            "action": {"sign_out": "Удалить это устройство"},
            "encryption": {"verification": {
                "use_recovery_key": "Используйте recovery key",
                "confirm_identity_title": "Подтвердите свою цифровую личность",
            }},
        }
        (i18n / "languages.json").write_text(json.dumps(
            {"en": self.en_name, "ru": self.ru_name}, indent=4) + "\n",
            encoding="utf-8")
        (i18n / self.ru_name).write_text(json.dumps(
            ru, ensure_ascii=False, indent=4) + "\n", encoding="utf-8")
        (i18n / self.en_name).write_text(json.dumps(
            {"action": {"sign_out_before_verify": "Sign out"}}, indent=4) + "\n",
            encoding="utf-8")
        self.en_before = (i18n / self.en_name).read_bytes()

        # Stock logo payload.
        (logos / "element-logo.svg").write_text("<svg>OLD</svg>", encoding="utf-8")
        (logos / "element-app-logo.png").write_bytes(b"old-png")
        (logos / "opengraph.png").write_bytes(b"old-og-png")

        # Assets the Dockerfile COPYs into /app before the brand pass.
        shutil.copyfile(WEBAPP / "plotina-icon.svg", self.app / "plotina-icon.svg")
        shutil.copyfile(WEBAPP / "plotina-512.png", self.app / "plotina-512.png")

    def run_branding(self, app: Path | None = None) -> subprocess.CompletedProcess:
        proc = subprocess.run(
            [sys.executable, str(BRANDING), "--app", str(app or self.app)],
            capture_output=True, text=True)
        return proc

    def brand(self) -> None:
        proc = self.run_branding()
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)

    def index(self) -> str:
        return (self.app / "index.html").read_text(encoding="utf-8")

    def error_view(self) -> str:
        return (self.app / "bundles" / BUNDLE / "error-view.js").read_text(encoding="utf-8")

    def logos(self) -> Path:
        return self.app / "themes" / "element" / "img" / "logos"

    def ru(self) -> dict:
        return json.loads((self.app / "i18n" / self.ru_name).read_text(
            encoding="utf-8"))


class IndexHtmlTest(AppFixture):
    def test_title(self) -> None:
        self.brand()
        html = self.index()
        self.assertIn("<title>Plotina Web</title>", html)
        self.assertNotIn("<title>Element</title>", html)

    def test_meta_names(self) -> None:
        self.brand()
        html = self.index()
        self.assertIn(
            '<meta name="apple-mobile-web-app-title" content="Plotina Web">', html)
        self.assertIn(
            '<meta name="application-name" content="Plotina Web">', html)
        self.assertNotIn('content="Element"', html)

    def test_theme_color(self) -> None:
        self.brand()
        html = self.index()
        self.assertIn('<meta name="theme-color" content="#17795A">', html)
        self.assertNotIn('content="#ffffff"', html)

    def test_og_image(self) -> None:
        self.brand()
        html = self.index()
        self.assertIn(
            '<meta property="og:image" content="https://chat.plotina.cc/plotina-512.png"',
            html)
        self.assertNotIn("app.element.io", html)

    def test_old_icons_removed_new_added(self) -> None:
        self.brand()
        html = self.index()
        self.assertNotIn("vector-icons/", html)
        self.assertNotIn('<link rel="apple-touch-icon" sizes="120x120"', html)
        self.assertIn('<link rel="icon" type="image/svg+xml" href="/plotina-icon.svg">', html)
        self.assertIn(
            '<link rel="apple-touch-icon" sizes="192x192" href="/plotina-icon-192.png">',
            html)
        # Stylesheet and manifest links are not icons and must survive.
        self.assertIn('<link rel="manifest" href="manifest.json">', html)
        self.assertIn(f"bundles/{BUNDLE}/bundle.css", html)

    def test_noscript(self) -> None:
        self.brand()
        html = self.index()
        self.assertIn("Plotina Web requires JavaScript to be enabled.", html)
        self.assertNotIn("Element requires JavaScript", html)

    def test_noise_scripts_untouched(self) -> None:
        self.brand()
        html = self.index()
        self.assertEqual(html.count(NOISE_TAG), 1)
        self.assertIn(NOISE_TAG + "</head>", html)

    def test_modal_a11y_style(self) -> None:
        self.brand()
        html = self.index()
        self.assertIn('<style id="plotina-modal-a11y">', html)
        self.assertEqual(html.count('<style id="plotina-modal-a11y">'), 1)
        self.assertIn(".mx_AuthPage_modal{margin-bottom:50px}", html)
        self.assertIn(".mx_AuthPage_modalContent>.mx_Dialog_border"
                      "{max-height:calc(100vh - 150px)}", html)
        self.assertIn(".mx_CompleteSecurityBody{overflow-y:auto}", html)
        # The style must land after bundle.css (equal-specificity cascade)
        # and must not split the noise tag pair.
        self.assertLess(html.index(f"bundles/{BUNDLE}/bundle.css"),
                        html.index('<style id="plotina-modal-a11y">'))
        self.assertLess(html.index('<style id="plotina-modal-a11y">'),
                        html.index(NOISE_TAG))


class ErrorViewTest(AppFixture):
    def test_logo_path_and_alt(self) -> None:
        self.brand()
        js = self.error_view()
        self.assertNotIn("themes/element/img/logos/element-app-logo.png", js)
        self.assertIn('src:"/plotina-512.png"', js)
        self.assertIn('alt:"Plotina"', js)
        self.assertNotIn('alt:"Element"', js)

    def test_other_chunks_untouched(self) -> None:
        self.brand()
        self.assertEqual(self.other_chunk.read_bytes(), self.other_before)
        self.assertIn("Element Call", self.other_chunk.read_text(encoding="utf-8"))


class LocaleTest(AppFixture):
    def test_missing_strings_added(self) -> None:
        self.brand()
        ru = self.ru()
        self.assertEqual(ru["action"]["sign_out_before_verify"], "Выйти")
        ver = ru["encryption"]["verification"]
        self.assertIn("no_other_devices", ver)
        self.assertIn("no_recovery_key", ver)
        self.assertTrue(ver["no_other_devices"].startswith("Этот параметр"))

    def test_existing_translations_survive(self) -> None:
        self.brand()
        ru = self.ru()
        self.assertEqual(ru["action"]["sign_out"], "Удалить это устройство")
        self.assertEqual(ru["encryption"]["verification"]["use_recovery_key"],
                         "Используйте recovery key")
        self.assertEqual(ru["encryption"]["verification"]["confirm_identity_title"],
                         "Подтвердите свою цифровую личность")

    def test_english_locale_untouched(self) -> None:
        self.brand()
        en = self.app / "i18n" / self.en_name
        self.assertEqual(en.read_bytes(), self.en_before)

    def test_second_run_adds_nothing(self) -> None:
        self.brand()
        before = (self.app / "i18n" / self.ru_name).read_bytes()
        proc = self.run_branding()
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        self.assertEqual((self.app / "i18n" / self.ru_name).read_bytes(), before)

    def test_missing_manifest_fails_loudly(self) -> None:
        (self.app / "i18n" / "languages.json").unlink()
        proc = self.run_branding()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("i18n", proc.stderr)

    def test_missing_ru_file_fails_loudly(self) -> None:
        (self.app / "i18n" / self.ru_name).unlink()
        proc = self.run_branding()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(self.ru_name, proc.stderr)


class ConfigJsonTest(AppFixture):
    def test_welcome_background_added_to_bare_config(self) -> None:
        self.brand()
        cfg = json.loads((self.app / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["branding"]["welcome_background_url"], "/plotina-bg.png")
        # Everything the brand pass does not own stays as shipped.
        self.assertEqual(cfg["default_theme"], "light")

    def test_existing_branding_block_preserved(self) -> None:
        cfg = {
            "brand": "Element",
            "branding": {"logo_link_url": "https://plotina.cc"},
        }
        (self.app / "config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        self.brand()
        out = json.loads((self.app / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(out["branding"]["logo_link_url"], "https://plotina.cc")
        self.assertEqual(out["branding"]["welcome_background_url"], "/plotina-bg.png")

    def test_missing_config_is_not_fatal(self) -> None:
        (self.app / "config.json").unlink()
        proc = self.run_branding()
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)


class LogoFilesTest(AppFixture):
    def test_element_logo_overwritten(self) -> None:
        self.brand()
        self.assertEqual(
            (self.logos() / "element-logo.svg").read_bytes(),
            (self.app / "plotina-icon.svg").read_bytes())

    def test_opengraph_removed(self) -> None:
        self.brand()
        self.assertFalse((self.logos() / "opengraph.png").exists())

    def test_noise_payload_untouched(self) -> None:
        self.brand()
        self.assertEqual((self.app / "noise" / "boot.js").read_bytes(),
                         self.noise_before)


class StrictnessTest(AppFixture):
    def test_second_run_is_idempotent(self) -> None:
        self.brand()
        before = self.index()
        proc = self.run_branding()
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
        after = self.index()
        self.assertEqual(after, before)
        self.assertEqual(after.count('href="/plotina-icon.svg"'), 1)
        self.assertEqual(after.count('<style id="plotina-modal-a11y">'), 1)

    def test_moved_upstream_title_fails_loudly(self) -> None:
        broken = Path(self._tmp.name) / "broken"
        shutil.copytree(self.app, broken)
        html = (broken / "index.html").read_text(encoding="utf-8")
        (broken / "index.html").write_text(
            html.replace("<title>Element</title>", "<title>Foo</title>"),
            encoding="utf-8")
        proc = self.run_branding(broken)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("index.html", proc.stderr)

    def test_missing_app_dir_fails(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(BRANDING), "--app", "/nonexistent-app-dir"],
            capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)


class RepositoryTest(unittest.TestCase):
    """The in-repo artefacts the Dockerfile and deploy flow rely on."""

    def test_repo_config_has_welcome_background(self) -> None:
        cfg = json.loads((WEBAPP / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["branding"]["welcome_background_url"], "/plotina-bg.png")

    def test_render_config_check_passes(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(WEBAPP / "scripts" / "render-config.py"),
             "--config", str(WEBAPP / "config.json"), "--check"],
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)

    def test_context_assets_match_branding_icons(self) -> None:
        # element-web/ is the Docker build context, so the raster assets are
        # duplicated there (same pattern as LICENSE-AGPL-3.0). Guard the copies
        # against drift from the canonical set in branding/icons/.
        pairs = [
            (WEBAPP / "plotina-512.png", ROOT / "branding" / "icons" / "png" / "green-512.png"),
            (WEBAPP / "plotina-bg.png", ROOT / "branding" / "icons" / "png" / "green-256.png"),
            (WEBAPP / "plotina-icon-192.png", ROOT / "branding" / "icons" / "png" / "green-192.png"),
            (WEBAPP / "plotina-icon.svg", ROOT / "branding" / "icons" / "plotina-green.svg"),
        ]
        for copy, canonical in pairs:
            with self.subTest(copy=copy.name):
                self.assertTrue(copy.is_file(), msg=f"{copy} missing")
                self.assertEqual(sha256(copy), sha256(canonical),
                                 msg=f"{copy} drifted from {canonical}")

    def test_dockerfile_delegates_branding_to_script(self) -> None:
        dockerfile = (WEBAPP / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("branding.py --app /app", dockerfile)
        self.assertIn("COPY branding.py", dockerfile)
        self.assertIn("rm -rf /app/mobile_guide", dockerfile)
        self.assertIn("/app/themes/element/img/logos/element-app-logo.png", dockerfile)
        # No hand-rolled brand seds may survive next to the script: every
        # remaining sed belongs to the noise or nginx layers, not the brand.
        brand_seds = [l for l in dockerfile.splitlines()
                      if "sed" in l and "Plotina" in l]
        self.assertEqual(brand_seds, [])
        self.assertNotIn("<title>Element</title>", dockerfile)
        # The noise overlay stays the overlay's own business.
        self.assertIn("noise/boot.js", dockerfile)


if __name__ == "__main__":
    unittest.main()
