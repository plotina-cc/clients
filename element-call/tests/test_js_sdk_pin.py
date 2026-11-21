"""Tests for the matrix-js-sdk pin that carries upstream fix #5522.

The pin has two halves that must not drift apart:

* ``element-call/pins.env`` says which js-sdk commit we build against and which
  upstream PR that commit is supposed to carry;
* ``element-call/patches/0008-...`` is what actually moves the node_modules
  graph there, because the upstream checkout is read-only for us.

A pin that only exists in one of the two is the failure this module is meant to
stop: pins.env would document a fix the bundle never saw, or a patch would move
the SDK to a commit nobody wrote down and nobody checked for the fix.

The runtime half of the same claim lives in ``build.py``: a source build refuses
a bundle that lacks ``JS_SDK_FIX_MARKER``, the string #5522 added to
``src/matrixrtc/MembershipManager.ts``. ``test_artifact_gate_*`` below is its
negative control.
"""

from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
EC = HERE.parent
sys.path.insert(0, str(EC))

import build as ecbuild  # noqa: E402

PR_URL = "https://github.com/matrix-org/matrix-js-sdk/pull/5522"
PIN_PATCH = EC / "patches" / "0008-plotina-js-sdk-5522.patch"


def pins() -> dict[str, str]:
    return ecbuild.load_pins(EC / "pins.env")


class PinsCarryTheJsSdkFix(unittest.TestCase):
    def test_commit_is_a_full_sha(self):
        pin = pins()["JS_SDK_COMMIT"]
        self.assertRegex(pin, r"^[0-9a-f]{40}$")

    def test_pin_names_the_version_and_the_pr(self):
        p = pins()
        self.assertEqual(p["JS_SDK_PR_URL"], PR_URL)
        # The version the pinned commit reports in its package.json; the report
        # quotes it, so a bump has to move this line with it.
        self.assertRegex(p["JS_SDK_VERSION"], r"^\d+\.\d+\.\d+$")

    def test_required_in_source_mode(self):
        ecbuild.require_pins({"JS_SDK_COMMIT": "0" * 40}, ["JS_SDK_COMMIT"])


class ThePatchMovesThePin(unittest.TestCase):
    """pins.env and patches/ must name the same commit, in every place."""

    def setUp(self):
        self.text = PIN_PATCH.read_text(encoding="utf-8")
        self.commit = pins()["JS_SDK_COMMIT"]

    def test_patch_exists_and_has_a_marker(self):
        self.assertTrue(PIN_PATCH.is_file())
        m = re.search(r"^# Plotina-Marker:[ \t]*(\S+)", self.text, re.M)
        self.assertIsNotNone(m, "0008 carries no '# Plotina-Marker:' header")

    def test_marker_is_on_an_added_line(self):
        marker = re.search(r"^# Plotina-Marker:[ \t]*(\S+)", self.text, re.M).group(1)
        added = [ln for ln in self.text.splitlines() if ln.startswith("+")]
        self.assertTrue(
            any(marker in ln for ln in added),
            "the marker must be introduced by the patch, not by a context line",
        )

    def test_package_json_specifier_matches_the_pin(self):
        added = [ln for ln in self.text.splitlines() if ln.startswith("+")]
        self.assertTrue(
            any(f'"matrix-js-sdk": "github:matrix-org/matrix-js-sdk#{self.commit}"' in ln
                for ln in added),
            "package.json must name the pinned commit, not the moving '#develop'",
        )

    def test_lockfile_resolves_to_the_same_commit(self):
        # tarball URL, the specifier in importers and the snapshot header all
        # have to agree, or `pnpm install --frozen-lockfile` in CI rejects the
        # tree or silently keeps the old graph.
        url = f"matrix-js-sdk/tar.gz/{self.commit}"
        self.assertGreaterEqual(
            sum(1 for ln in self.text.splitlines()
                if ln.startswith("+") and url in ln),
            3,
            "the lock hunk has to rewrite the importer, the package and the snapshot",
        )
        # The integrity line has to come from the same commit's tarball, i.e.
        # it must be the sha512 pnpm recorded, not a hand-written placeholder.
        integrity = [ln for ln in self.text.splitlines()
                     if ln.startswith("+") and "integrity: sha512-" in ln and url in ln]
        self.assertEqual(len(integrity), 1)

    def test_the_old_pin_is_gone(self):
        self.assertNotIn("24929be0e741be6a5d0a7226f1c682e245263b8a",
                         "\n".join(ln for ln in self.text.splitlines() if ln.startswith("+")))


class TheBundleGate(unittest.TestCase):
    """build.py must refuse a bundle that does not carry the #5522 code."""

    def test_marker_is_the_string_the_fix_adds(self):
        self.assertEqual(ecbuild.JS_SDK_FIX_MARKER, "no delayed leave event is scheduled")

    def test_accepts_a_bundle_with_the_fix(self):
        with tempfile.TemporaryDirectory() as td:
            dist = Path(td)
            (dist / "assets").mkdir()
            (dist / "assets" / "index-abc.js").write_text(
                'const a=1;warn("no delayed leave event is scheduled")', encoding="utf-8")
            ecbuild.assert_js_sdk_fix(dist)  # must not raise

    def test_rejects_a_bundle_without_the_fix(self):
        # Negative control: the same shape as the .17 bundle, which carries
        # restartScheduledDelayedEvent but not this string.
        with tempfile.TemporaryDirectory() as td:
            dist = Path(td)
            (dist / "assets").mkdir()
            (dist / "assets" / "index-abc.js").write_text(
                'const a=1;"restartScheduledDelayedEvent"', encoding="utf-8")
            with self.assertRaises(ecbuild.BuildError) as cm:
                ecbuild.assert_js_sdk_fix(dist)
            self.assertIn(ecbuild.JS_SDK_FIX_MARKER, str(cm.exception))


if __name__ == "__main__":
    unittest.main()
