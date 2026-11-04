"""Unit tests for element-call/branding.py (run: python3 -m unittest discover -s element-call/tests).

The fixtures in ``fixtures.py`` are byte-faithful excerpts of the pinned
upstream v0.26.1 bundle, so the strict replacement counters asserted here are
the same counters branding.py asserts against a real dist.
"""

from __future__ import annotations

import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

import branding  # noqa: E402
import fixtures  # noqa: E402

REPO = HERE.parent.parent
ICONS = REPO / "branding" / "icons"


class HtmlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.out, self.counts = branding.brand_html(fixtures.UNBRANDED_INDEX)

    def test_product_name_gone_from_index(self) -> None:
        self.assertNotIn("Element Call", self.out)

    def test_title_and_social_titles(self) -> None:
        self.assertIn("<title>Plotina Call</title>", self.out)
        self.assertIn('<meta property="og:title" content="Plotina Call">', self.out)
        self.assertIn('<meta name="twitter:title" content="Plotina Call">', self.out)

    def test_social_descriptions(self) -> None:
        self.assertNotIn("join a call on Element Call", self.out)
        self.assertEqual(
            self.out.count('content="You\'re invited to join a call on Plotina Call"'), 2
        )

    def test_social_images_point_at_the_512(self) -> None:
        self.assertIn('<meta property="og:image" content="/plotina-512.png">', self.out)
        self.assertIn('<meta name="twitter:image" content="/plotina-512.png">', self.out)
        self.assertNotIn('content="favicon.png"', self.out)

    def test_icon_link_points_at_the_svg(self) -> None:
        self.assertIn('<link rel="icon" type="image/svg+xml" href="/plotina-icon.svg">', self.out)
        self.assertNotIn('href="favicon.png"', self.out)

    def test_noise_tags_and_assets_untouched(self) -> None:
        # branding runs after inject-noise.py and must not move its tags.
        self.assertIn('<script src="/noise/logic.js"></script>', self.out)
        self.assertIn('src="/assets/index-FUQuguOr.js"', self.out)
        self.assertEqual(self.out.find("/noise/logic.js") < self.out.find('type="module"'), True)

    def test_counters(self) -> None:
        self.assertEqual(
            self.counts,
            {
                "title": 1,
                "og_title": 1,
                "twitter_title": 1,
                "social_description": 2,
                "og_image": 1,
                "twitter_image": 1,
                "icon_link": 1,
            },
        )

    def test_idempotent(self) -> None:
        again, counts = branding.brand_html(self.out)
        self.assertEqual(again, self.out)
        self.assertEqual(counts, self.counts)

    def test_unexpected_html_count_fails_loudly(self) -> None:
        broken = fixtures.UNBRANDED_INDEX.replace("<title>Element Call</title>", "")
        with self.assertRaises(branding.BrandingError):
            branding.brand_html(broken)


class BundleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.out, self.counts = branding.brand_js(fixtures.UNBRANDED_BUNDLE)

    def test_document_title_template(self) -> None:
        self.assertIn("let t=`Plotina Call`;document.title=", self.out)
        self.assertNotIn("let t=`Element Call`", self.out)

    def test_beta_logo_label(self) -> None:
        self.assertIn("children:`Plotina Call`", self.out)
        self.assertNotIn("(Beta)", self.out)

    def test_product_name_argument(self) -> None:
        self.assertIn("{productName:`Plotina Call`,version:`v0.26.1`}", self.out)

    def test_close_host_error(self) -> None:
        self.assertEqual(
            self.out.count("`Failed to ask the host to close Plotina Call`"), 2
        )

    def test_brand_arguments(self) -> None:
        self.assertEqual(self.out.count("brand:`Plotina Call`"), 2)

    def test_version_log(self) -> None:
        self.assertIn("F.info(`Plotina Call v0.26.1`)", self.out)

    def test_only_the_listed_literals_move(self) -> None:
        # The logo's aria-label is not in the rule list: a broad grep-and-replace
        # would have taken it, the counter-driven version must not.
        self.assertIn("`aria-label`:`Element Call`", self.out)

    def test_urls(self) -> None:
        self.assertIn("href:`https://plotina.cc`", self.out)
        self.assertEqual(self.out.count("https://plotina.cc"), 2)
        self.assertIn("linkUrl:`https://github.com/plotina-cc/clients`", self.out)
        self.assertNotIn("element.io", self.out.replace("static.element.io", ""))

    def test_counters(self) -> None:
        self.assertEqual(
            self.counts,
            {
                "document_title": 1,
                "beta_logo_label": 1,
                "product_name": 1,
                "close_host_error": 2,
                "brand_argument": 2,
                "version_log": 1,
                "privacy_url": 1,
                "cookie_policy_url": 1,
                "docs_url": 1,
            },
        )

    def test_total_reduction_equals_the_counters(self) -> None:
        before = fixtures.UNBRANDED_BUNDLE.count("Element Call")
        after = self.out.count("Element Call")
        renamed = sum(v for k, v in self.counts.items() if not k.endswith("_url"))
        self.assertEqual(before - after, renamed)

    def test_idempotent(self) -> None:
        again, counts = branding.brand_js(self.out)
        self.assertEqual(again, self.out)
        self.assertEqual(counts, self.counts)

    def test_missing_occurrence_fails_loudly(self) -> None:
        # One of the two close-host call sites removed: the counter must abort
        # rather than brand a half-patched bundle.
        one = fixtures.UNBRANDED_BUNDLE.replace(
            "function ASe(e){F.error(`Failed to ask the host to close Element Call`,e)}\n", ""
        )
        with self.assertRaises(branding.BrandingError) as ctx:
            branding.brand_js(one)
        self.assertIn("close_host_error", str(ctx.exception))

    def test_extra_occurrence_fails_loudly(self) -> None:
        extra = fixtures.UNBRANDED_BUNDLE + "{brand:`Element Call`}\n"
        with self.assertRaises(branding.BrandingError) as ctx:
            branding.brand_js(extra)
        self.assertIn("brand_argument", str(ctx.exception))


class QuoteStyleTests(unittest.TestCase):
    """The minifier's quote choice is not ours to predict."""

    def test_single_and_double_quoted_literals(self) -> None:
        out, counts = branding.brand_js(fixtures.UNBRANDED_BUNDLE_QUOTES, strict=False)
        self.assertIn('let t="Plotina Call";document.title=', out)
        self.assertIn("'Plotina Call'", out)  # was: 'Element Call (Beta)'
        self.assertNotIn("Beta", out)
        self.assertIn("{productName:'Plotina Call',version:'v0.26.1'}", out)
        self.assertIn("brand:'Plotina Call'", out)
        self.assertIn("console.info('Plotina Call 0.26.1')", out)
        self.assertIn('href="https://plotina.cc"', out)
        self.assertIn("url='https://github.com/plotina-cc/clients'", out)
        self.assertNotIn("element.io", out)
        # An unrelated assignment of the old name is left alone.
        self.assertIn('el.title = "Element Call"', out)
        self.assertEqual(counts["close_host_error"], 1)


class DistTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ec-branding-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.dist = self.tmp / "dist"
        self._make_dist()

    def _make_dist(self, index: str | None = None, bundle: str | None = None) -> Path:
        (self.dist / "assets").mkdir(parents=True, exist_ok=True)
        (self.dist / "index.html").write_text(
            index if index is not None else fixtures.UNBRANDED_INDEX, encoding="utf-8"
        )
        js = bundle if bundle is not None else fixtures.UNBRANDED_BUNDLE
        (self.dist / "assets" / "index-FUQuguOr.js").write_text(js, encoding="utf-8")
        (self.dist / "assets" / "en-app-DpQMyCEJ.json").write_text(
            '{"header_label": "Element Call Home"}', encoding="utf-8"
        )
        (self.dist / "assets" / "index-ODgY4f6W.js.map").write_text(
            '{"sources": ["Element Call"]}', encoding="utf-8"
        )
        (self.dist / "favicon.png").write_bytes(b"upstream-favicon-bytes")
        return self.dist

    def test_apply_writes_html_and_bundle(self) -> None:
        report = branding.apply_dist(self.dist, ICONS)
        index = (self.dist / "index.html").read_text(encoding="utf-8")
        js = (self.dist / "assets" / "index-FUQuguOr.js").read_text(encoding="utf-8")
        self.assertNotIn("Element Call", index)
        self.assertIn("Plotina Call", index)
        self.assertIn("let t=`Plotina Call`", js)
        self.assertTrue(report.ok)

    def test_icon_files_are_carried_in(self) -> None:
        branding.apply_dist(self.dist, ICONS)
        self.assertEqual(
            (self.dist / "favicon.png").read_bytes(), (ICONS / "png" / "green-48.png").read_bytes()
        )
        self.assertEqual(
            (self.dist / "plotina-512.png").read_bytes(),
            (ICONS / "png" / "green-512.png").read_bytes(),
        )
        self.assertIn("Plotina", (self.dist / "plotina-icon.svg").read_text(encoding="utf-8"))
        self.assertNotIn("Element", (self.dist / "plotina-icon.svg").read_text(encoding="utf-8"))

    def test_non_js_assets_untouched(self) -> None:
        branding.apply_dist(self.dist, ICONS)
        self.assertIn(
            "Element Call",
            (self.dist / "assets" / "en-app-DpQMyCEJ.json").read_text(encoding="utf-8"),
        )

    def test_sourcemaps_untouched(self) -> None:
        before = (self.dist / "assets" / "index-ODgY4f6W.js.map").read_bytes()
        branding.apply_dist(self.dist, ICONS)
        self.assertEqual(
            hashlib.sha256(before).hexdigest(),
            hashlib.sha256((self.dist / "assets" / "index-ODgY4f6W.js.map").read_bytes()).hexdigest(),
        )

    def test_check_accepts_the_branded_dist(self) -> None:
        branding.apply_dist(self.dist, ICONS)
        self.assertEqual(branding.check_dist(self.dist, ICONS), [])
        self.assertEqual(branding.main(["branding.py", "--check", str(self.dist)]), 0)

    def test_check_rejects_the_unbranded_dist(self) -> None:
        errors = branding.check_dist(self.dist, ICONS)
        self.assertTrue(errors)
        self.assertEqual(branding.main(["branding.py", "--check", str(self.dist)]), 1)

    def test_check_rejects_a_partially_branded_bundle(self) -> None:
        branding.apply_dist(self.dist, ICONS)
        js = self.dist / "assets" / "index-FUQuguOr.js"
        js.write_text(
            js.read_text(encoding="utf-8").replace("Plotina Call", "Element Call", 1),
            encoding="utf-8",
        )
        self.assertTrue(branding.check_dist(self.dist, ICONS))

    def test_check_rejects_a_stale_favicon(self) -> None:
        branding.apply_dist(self.dist, ICONS)
        (self.dist / "favicon.png").write_bytes(b"upstream-favicon-bytes")
        self.assertTrue(any("favicon" in e for e in branding.check_dist(self.dist, ICONS)))

    def test_apply_is_idempotent(self) -> None:
        first = branding.apply_dist(self.dist, ICONS)
        index = (self.dist / "index.html").read_bytes()
        js = (self.dist / "assets" / "index-FUQuguOr.js").read_bytes()
        second = branding.apply_dist(self.dist, ICONS)
        self.assertEqual((self.dist / "index.html").read_bytes(), index)
        self.assertEqual((self.dist / "assets" / "index-FUQuguOr.js").read_bytes(), js)
        self.assertEqual(first.counts, second.counts)

    def test_missing_dist_is_a_usage_error(self) -> None:
        self.assertEqual(branding.main(["branding.py", str(self.tmp / "nope")]), 2)

    def test_absent_icon_source_is_an_error(self) -> None:
        empty = self.tmp / "icons"
        empty.mkdir()
        with self.assertRaises(branding.BrandingError):
            branding.apply_dist(self.dist, empty)

    def test_no_args_is_a_usage_error(self) -> None:
        # argparse owns the "missing argument" case and exits 2, the same code
        # this script uses for a dist that is not there.
        with self.assertRaises(SystemExit) as ctx:
            branding.main(["branding.py"])
        self.assertEqual(ctx.exception.code, 2)


class TableTests(unittest.TestCase):
    """The rule tables themselves: one rule per literal, nothing broader."""

    def test_every_js_rule_matches_the_pinned_bundle(self) -> None:
        for sub in branding.JS_SUBS:
            self.assertIn(sub.upstream, fixtures.UNBRANDED_BUNDLE, sub.name)
            self.assertEqual(
                len(sub.old_re.findall(fixtures.UNBRANDED_BUNDLE)),
                sub.expected,
                sub.name,
            )

    def test_rename_rules_hold_the_product_name(self) -> None:
        for sub in branding.JS_SUBS + branding.HTML_SUBS:
            self.assertEqual(
                branding.UPSTREAM_NAME in sub.upstream,
                sub.renames,
                sub.name,
            )
            self.assertEqual(sub.upstream.count(branding.UPSTREAM_NAME), sub.name_tokens)

    def test_no_rule_is_a_bare_name_match(self) -> None:
        # A bare "Element Call" pattern would be a grep-and-replace: every rule
        # has to carry the context that identifies its literal.
        bare = branding._lit(branding.UPSTREAM_NAME)
        for sub in list(branding.JS_SUBS) + list(branding.HTML_SUBS):
            self.assertNotEqual(sub.old, bare, sub.name)
            self.assertGreater(len(sub.old), len(bare), sub.name)

    def test_rule_names_are_unique(self) -> None:
        names = [s.name for s in list(branding.JS_SUBS) + list(branding.HTML_SUBS)]
        self.assertEqual(len(names), len(set(names)))

    def test_renamed_requires_exactly_one_name_token(self) -> None:
        with self.assertRaises(ValueError):
            branding.renamed("bogus", "no token here", 1)


if __name__ == "__main__":
    unittest.main()
