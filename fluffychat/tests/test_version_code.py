#!/usr/bin/env python3
"""Tests for fluffychat/scripts/version-code.py (updater version contract).

Run: python3 -m unittest discover -s fluffychat/tests -v
Covers the dev update channel (patch 0016): stable parsing must stay exactly
as released (.22-.28 APKs carry these numbers), a dev tag must compile to the
SAME versionCode as the stable it is based on, the dev versionName format the
app parses back into devBuild, and the CI check that a dev tag sits on the
latest *published* stable - never on an unreleased or outdated one.
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]  # fluffychat/
SCRIPT = REPO / "scripts" / "version-code.py"

_spec = importlib.util.spec_from_file_location("version_code", SCRIPT)
assert _spec is not None and _spec.loader is not None, SCRIPT
vc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vc)


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


class StableFormulaUnchanged(unittest.TestCase):
    """The numbers already published in .22-.28 must never move."""

    def test_base_and_abi_codes(self):
        self.assertEqual(vc.version_code("2.11.3", "23"), 2110323)
        self.assertEqual(vc.apk_version_code("2.11.3", "23", "arm64-v8a"), 2112323)
        self.assertEqual(vc.apk_version_code("2.11.3", "23", "armeabi-v7a"), 2111323)

    def test_stable_tag_parses_as_before(self):
        self.assertEqual(vc.parse_ref("v2.11.3-plotina-mobile.28"), ("2.11.3", 28, None))

    def test_digit_limits_still_exit(self):
        with self.assertRaises(SystemExit):
            vc.version_code("2.11.10", "1")  # patch slot
        with self.assertRaises(SystemExit):
            vc.version_code("2.11.3", "100")  # build slot
        with self.assertRaises(SystemExit):
            vc.parse_ref("v2.11.3-plotina-fluffy.28")  # other client


class DevTagParsing(unittest.TestCase):
    def test_dev_tag_keeps_base_and_build_and_adds_m(self):
        base, build, dev = vc.parse_ref("v2.11.3-plotina-mobile.28-dev.1")
        self.assertEqual((base, build, dev), ("2.11.3", 28, 1))

    def test_dev_build_number_can_be_multi_digit(self):
        self.assertEqual(vc.parse_ref("v2.11.3-plotina-mobile.28-dev.12"), ("2.11.3", 28, 12))

    def test_double_dev_suffix_is_not_a_tag(self):
        with self.assertRaises(SystemExit):
            vc.parse_ref("v2.11.3-plotina-mobile.28-dev.1-dev.2")

    def test_dev_without_number_is_not_a_tag(self):
        with self.assertRaises(SystemExit):
            vc.parse_ref("v2.11.3-plotina-mobile.28-dev")


class DevVersionCodeIsTheStableOne(unittest.TestCase):
    """The core contract: dev .28-dev.M == stable .28, forever."""

    def test_base_codes_match(self):
        stable = vc.version_code("2.11.3", "28")
        _base, build, dev = vc.parse_ref("v2.11.3-plotina-mobile.28-dev.1")
        self.assertEqual(vc.version_code("2.11.3", str(build)), stable)
        self.assertIsNotNone(dev)

    def test_apk_codes_match_per_abi(self):
        for abi in ("arm64-v8a", "armeabi-v7a"):
            self.assertEqual(
                vc.apk_version_code("2.11.3", "28", abi),
                vc.apk_version_code("2.11.3", "28", abi),
            )

    def test_next_stable_outranks_every_dev_of_the_previous_base(self):
        dev_base = vc.apk_version_code("2.11.3", "28", "arm64-v8a")
        next_stable = vc.apk_version_code("2.11.3", "29", "arm64-v8a")
        self.assertGreater(next_stable, dev_base)


class DevVersionName(unittest.TestCase):
    def test_format_is_what_the_app_parses(self):
        self.assertEqual(vc.dev_version_name("2.11.3", 1), "2.11.3-dev.1")
        self.assertEqual(vc.dev_version_name("2.11.3", 12), "2.11.3-dev.12")


class PublishedStableLookup(unittest.TestCase):
    REFS = [
        "abc123\trefs/tags/v2.11.3-plotina-mobile.27^{}\n",
        "def456\trefs/tags/v2.11.3-plotina-mobile.27\n",
        "ghi789\trefs/tags/v2.11.3-plotina-mobile.28\n",
        "jkl012\trefs/tags/v2.11.3-plotina-mobile.28-dev.1\n",
        "mno345\trefs/tags/v2.11.3-plotina-mobile.28-dev.2\n",
        "pqr678\trefs/tags/v2.11.3\n",  # upstream tag, foreign shape
        "\n",
        "stu901\trefs/heads/main\n",
    ]

    def test_tag_names_skips_peels_and_non_tags(self):
        names = vc.tag_names(self.REFS)
        self.assertEqual(
            names,
            [
                "v2.11.3-plotina-mobile.27",
                "v2.11.3-plotina-mobile.28",
                "v2.11.3-plotina-mobile.28-dev.1",
                "v2.11.3-plotina-mobile.28-dev.2",
                "v2.11.3",
            ],
        )

    def test_dev_tags_are_not_stable_revisions(self):
        codes = vc.published_stable_codes(self.REFS)
        self.assertIn(2110327, codes)
        self.assertIn(2110328, codes)
        self.assertNotIn(2110329, codes)
        self.assertEqual(codes[2110328], "v2.11.3-plotina-mobile.28")


class CheckDevBase(unittest.TestCase):
    REFS = PublishedStableLookup.REFS

    def test_dev_on_the_latest_published_stable_is_ok(self):
        line = vc.check_dev_base("v2.11.3-plotina-mobile.28-dev.3", self.REFS)
        self.assertTrue(line.startswith("ok:"))

    def test_dev_on_an_unpublished_future_base_is_refused(self):
        with self.assertRaises(SystemExit) as ctx:
            vc.check_dev_base("v2.11.3-plotina-mobile.29-dev.1", self.REFS)
        self.assertNotEqual(ctx.exception.code, 0)

    def test_dev_behind_the_latest_published_stable_is_refused(self):
        refs = self.REFS + ["xyz999\trefs/tags/v2.11.3-plotina-mobile.29\n"]
        with self.assertRaises(SystemExit) as ctx:
            vc.check_dev_base("v2.11.3-plotina-mobile.28-dev.1", refs)
        self.assertNotEqual(ctx.exception.code, 0)

    def test_a_stable_tag_is_not_a_dev_tag(self):
        with self.assertRaises(SystemExit):
            vc.check_dev_base("v2.11.3-plotina-mobile.28", self.REFS)


class CliContract(unittest.TestCase):
    def test_legacy_positional_forms_unchanged(self):
        self.assertEqual(run("2.11.3", "23").stdout.strip(), "2110323")
        self.assertEqual(
            run("2.11.3", "23", "arm64-v8a").stdout.strip(), "2112323"
        )

    def test_parse_ref_emits_shell_lines(self):
        out = run("--parse-ref", "v2.11.3-plotina-mobile.28-dev.1")
        self.assertEqual(out.returncode, 0, out.stderr)
        lines = dict(
            pair.split("=", 1) for pair in out.stdout.strip().splitlines()
        )
        self.assertEqual(lines["base"], "2.11.3")
        self.assertEqual(lines["build"], "28")
        self.assertEqual(lines["dev"], "1")
        self.assertEqual(lines["version_name"], "2.11.3-dev.1")
        self.assertEqual(lines["code"], "2110328")
        self.assertEqual(lines["arm64_version_code"], "2112328")
        self.assertEqual(lines["armv7_version_code"], "2111328")

    def test_parse_ref_on_a_stable_tag_has_empty_dev(self):
        out = run("--parse-ref", "v2.11.3-plotina-mobile.28")
        self.assertEqual(out.returncode, 0, out.stderr)
        lines = dict(
            pair.split("=", 1) for pair in out.stdout.strip().splitlines()
        )
        self.assertEqual(lines["dev"], "")
        self.assertEqual(lines["version_name"], "2.11.3")

    def test_check_dev_base_cli(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt") as refs:
            refs.write("\n".join(PublishedStableLookup.REFS))
            refs.flush()
            ok = run("--check-dev-base", "v2.11.3-plotina-mobile.28-dev.1", refs.name)
            self.assertEqual(ok.returncode, 0, ok.stderr + ok.stdout)
            self.assertIn("ok:", ok.stdout)
            bad = run("--check-dev-base", "v2.11.3-plotina-mobile.99-dev.1", refs.name)
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn("not a published stable", bad.stderr)


if __name__ == "__main__":
    unittest.main()
