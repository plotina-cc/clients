#!/usr/bin/env python3
"""Tests for ../branding.py: the Plotina shell over the Element webapp bundle.

Fixtures mirror the real element-web v1.12.32 release layout (index.html,
bundles/<hash>/error-view.js, themes/element/img/logos/element-app-logo.png,
mobile_guide/, manifest.json) in a temp directory; branding.py runs as a CLI.

    cd element-desktop && python3 -m unittest discover -s tests -v
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRANDING = HERE.parent / "branding.py"
REAL_ICONS = HERE.parents[1] / "branding" / "icons"

INDEX_HTML = """<!doctype html>
<html lang="en" style="height: 100%;">
  <head>
    <meta charset="utf-8">
    <title>Element</title>
    <link rel="apple-touch-icon" sizes="120x120" href="vector-icons/120.570a7f9.png">
    <link rel="apple-touch-icon" sizes="180x180" href="vector-icons/180.30b915f.png">
    <link rel="manifest" href="manifest.json">
    <meta name="referrer" content="no-referrer">
    <link rel="icon" type="image/png" sizes="24x24" href="vector-icons/24.97ab000.png">
    <link rel="icon" type="image/png" sizes="512x512" href="vector-icons/512.7ce350d.png">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="apple-mobile-web-app-title" content="Element">
    <meta name="application-name" content="Element">
    <meta name="theme-color" content="#ffffff">
    <meta property="og:image" content="https://app.element.io/themes/element/img/logos/opengraph.png" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none';">
    <link rel="stylesheet" href="bundles/7fef2be0ae8530458db3/bundle.css">
  </head>
  <body style="height: 100%; margin: 0;">
    <noscript>Sorry, Element requires JavaScript to be enabled.</noscript> <!-- TODO: Translate this? -->
    <div id="matrixchat" style="height: 100%;" class="notranslate"></div>
    <script src="bundles/7fef2be0ae8530458db3/bundle.js"></script>
  </body>
</html>
"""

# Verbatim shape of the v1.12.32 minified error view: the logo <img> is
# createElement(...) in a bundle, so the attribute syntax is JS, not HTML.
ERROR_VIEW_JS = (
    '(() => {const r=require("react");exports.ErrorView=()=>r.createElement("div",'
    '{className:"mx_ErrorView cpd-theme-light"},r.createElement("img",{className:'
    '"mx_ErrorView_logo",height:"160",src:"themes/element/img/logos/'
    'element-app-logo.png",alt:"Element"}),r.createElement("div",{className:'
    '"mx_ErrorView_container"},r.createElement("a",{href:"https://app.element.io"'
    ',alt:"Element web client"})));})();\n'
)

LOGO_BYTES = b"\x89PNG\r\n\x1a\n fake element logo"
GREEN_SVG = b'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect fill="#17795A"/></svg>\n'
GREEN_192 = b"\x89PNG\r\n\x1a\n fake plotina 192"
GREEN_512 = b"\x89PNG\r\n\x1a\n fake plotina 512"

MANIFEST = {
    "name": "Element",
    "short_name": "Element",
    "display": "standalone",
    "theme_color": "#76CFA6",
    "start_url": "index.html",
    "icons": [{"src": "/vector-icons/512.png", "sizes": "512x512", "type": "image/png"}],
}


class BrandingTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="ed-branding-")
        self.tmp = Path(self._tmp.name)
        self.webapp = self.tmp / "webapp"
        self.icons = self.tmp / "icons"
        self._make_webapp()
        self._make_icons()

    def tearDown(self):
        self._tmp.cleanup()

    def _make_webapp(self, with_manifest=True, with_logo=True, with_mobile_guide=True):
        bundle = self.webapp / "bundles" / "7fef2be0ae8530458db3"
        bundle.mkdir(parents=True)
        (self.webapp / "index.html").write_text(INDEX_HTML, encoding="utf-8")
        (bundle / "error-view.js").write_text(ERROR_VIEW_JS, encoding="utf-8")
        (bundle / "bundle.js").write_text("//\n", encoding="utf-8")
        if with_logo:
            logos = self.webapp / "themes" / "element" / "img" / "logos"
            logos.mkdir(parents=True)
            (logos / "element-app-logo.png").write_bytes(LOGO_BYTES)
        if with_mobile_guide:
            guide = self.webapp / "mobile_guide"
            guide.mkdir()
            (guide / "index.html").write_text("<title>Element mobile guide</title>\n", encoding="utf-8")
        if with_manifest:
            (self.webapp / "manifest.json").write_text(
                json.dumps(MANIFEST, indent=4) + "\n", encoding="utf-8"
            )

    def _make_icons(self, with_assets=True):
        (self.icons / "png").mkdir(parents=True)
        if not with_assets:
            return
        (self.icons / "plotina-green.svg").write_bytes(GREEN_SVG)
        (self.icons / "png" / "green-192.png").write_bytes(GREEN_192)
        (self.icons / "png" / "green-512.png").write_bytes(GREEN_512)

    def run_branding(self, webapp=None, icons=None):
        args = [
            sys.executable, str(BRANDING),
            "--webapp", str(webapp or self.webapp),
            "--icons", str(icons or self.icons),
        ]
        return subprocess.run(args, capture_output=True, text=True)

    def index(self):
        return (self.webapp / "index.html").read_text(encoding="utf-8")

    def error_view(self):
        return (self.webapp / "bundles" / "7fef2be0ae8530458db3" / "error-view.js").read_text(encoding="utf-8")

    # -- CLI plumbing --------------------------------------------------------

    def test_cli_ok(self):
        result = self.run_branding()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("branded", result.stdout.lower())

    def test_rejects_non_webapp(self):
        empty = self.tmp / "nope"
        empty.mkdir()
        result = self.run_branding(webapp=empty)
        self.assertNotEqual(result.returncode, 0)

    def test_fails_when_icon_assets_missing(self):
        bare = self.tmp / "bare-icons"
        (bare / "png").mkdir(parents=True)
        # the icons dir exists but carries no Plotina assets: fail loudly
        # instead of shipping a half-branded webapp
        result = self.run_branding(icons=bare)
        self.assertNotEqual(result.returncode, 0)


class TestIndexHtml(BrandingTest):
    def setUp(self):
        super().setUp()
        result = self.run_branding()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_title(self):
        src = self.index()
        self.assertIn("<title>Plotina Desktop</title>", src)
        self.assertNotIn(">Element</title>", src)

    def test_app_name_meta(self):
        src = self.index()
        self.assertIn('<meta name="apple-mobile-web-app-title" content="Plotina Desktop">', src)
        self.assertIn('<meta name="application-name" content="Plotina Desktop">', src)
        self.assertNotIn('content="Element"', src)

    def test_theme_color(self):
        self.assertIn('<meta name="theme-color" content="#17795A">', self.index())

    def test_og_image_is_local(self):
        src = self.index()
        self.assertNotIn("app.element.io", src)
        self.assertIn('<meta property="og:image" content="plotina-512.png"', src)

    def test_element_icon_links_gone(self):
        src = self.index()
        self.assertNotIn("vector-icons", src)
        self.assertIn('<link rel="manifest" href="manifest.json">', src)  # kept

    def test_plotina_icon_links_added(self):
        src = self.index()
        self.assertIn('rel="icon"', src)
        self.assertIn("plotina-icon.svg", src)
        self.assertIn('rel="apple-touch-icon"', src)
        self.assertIn("plotina-icon-192.png", src)
        # our links come once, inside the head
        self.assertEqual(src.count("plotina-icon.svg"), 1)
        head = src.split("</head>")[0]
        self.assertIn("plotina-icon.svg", head)

    def test_noscript(self):
        src = self.index()
        self.assertIn("<noscript>Plotina Desktop requires JavaScript to be enabled.</noscript>", src)
        self.assertNotIn("Sorry, Element", src)

    def test_script_and_style_tags_untouched(self):
        src = self.index()
        self.assertIn('<script src="bundles/7fef2be0ae8530458db3/bundle.js"></script>', src)
        self.assertIn('<link rel="stylesheet" href="bundles/7fef2be0ae8530458db3/bundle.css">', src)


class TestIcons(BrandingTest):
    def setUp(self):
        super().setUp()
        result = self.run_branding()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_copied_into_webapp(self):
        self.assertEqual((self.webapp / "plotina-icon.svg").read_bytes(), GREEN_SVG)
        self.assertEqual((self.webapp / "plotina-icon-192.png").read_bytes(), GREEN_192)
        self.assertEqual((self.webapp / "plotina-512.png").read_bytes(), GREEN_512)

    def test_element_app_logo_file_overwritten(self):
        logo = self.webapp / "themes" / "element" / "img" / "logos" / "element-app-logo.png"
        self.assertEqual(logo.read_bytes(), GREEN_512)


class TestErrorView(BrandingTest):
    def setUp(self):
        super().setUp()
        result = self.run_branding()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_logo_src_replaced(self):
        src = self.error_view()
        self.assertNotIn("element-app-logo.png", src)
        self.assertIn('src:"plotina-512.png"', src)

    def test_alt_replaced(self):
        src = self.error_view()
        self.assertIn('alt:"Plotina"', src)
        self.assertNotIn('alt:"Element"', src)

    def test_other_alts_untouched(self):
        self.assertIn('alt:"Element web client"', self.error_view())

    def test_error_view_absent_fails_loudly(self):
        shutil.rmtree(self.webapp / "bundles")
        result = self.run_branding()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error-view", result.stderr.lower())


class TestRemovals(BrandingTest):
    def setUp(self):
        super().setUp()
        result = self.run_branding()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_mobile_guide_removed(self):
        self.assertFalse((self.webapp / "mobile_guide").exists())

    def test_mobile_guide_absent_is_fine(self):
        # second run (the guide is already gone from setUp's run) must not crash
        self.assertFalse((self.webapp / "mobile_guide").exists())
        result = self.run_branding()
        self.assertEqual(result.returncode, 0, result.stderr)


class TestManifest(BrandingTest):
    def test_renamed(self):
        result = self.run_branding()
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads((self.webapp / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(data["name"], "Plotina Desktop")
        self.assertEqual(data["short_name"], "Plotina Desktop")

    def test_missing_manifest_is_fine(self):
        (self.webapp / "manifest.json").unlink()
        result = self.run_branding()
        self.assertEqual(result.returncode, 0, result.stderr)


class TestIdempotent(BrandingTest):
    def test_second_run_noop(self):
        first = self.run_branding()
        self.assertEqual(first.returncode, 0, first.stderr)
        index_after = self.index()
        view_after = self.error_view()
        second = self.run_branding()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(self.index(), index_after)
        self.assertEqual(self.error_view(), view_after)


class TestRealAssets(BrandingTest):
    """The shipped repo icons must be complete for every size branding.py uses."""

    def test_repo_icon_sources_exist(self):
        self.assertTrue((REAL_ICONS / "plotina-green.svg").is_file())
        self.assertTrue((REAL_ICONS / "png" / "green-192.png").is_file())
        self.assertTrue((REAL_ICONS / "png" / "green-512.png").is_file())

    def test_runs_against_repo_icons(self):
        result = self.run_branding(icons=REAL_ICONS)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('<meta name="theme-color" content="#17795A">', self.index())


if __name__ == "__main__":
    unittest.main()
