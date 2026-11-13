#!/usr/bin/env python3
"""Tests for fluffychat/scripts/abi-matrix.py (which ABIs a Mobile build compiles).

Run: python3 -m unittest discover -s fluffychat/tests -p 'test_*.py' -v

The rule the owner asked for: a **dev** tag (v<base>-plotina-mobile.<N>-dev.<M>)
compiles and ships `android-arm64` only, because the dev loop is
"fix -> build -> check on one phone"; a **stable** tag keeps the three ABIs it
always had (arm64, armv7, x86_64), so nothing is lost for users.  CI reads the
matrix from this script instead of spelling the ABI lists out per step, which
is what these tests pin: the decision, the three lists that must agree with
each other, and the workflow actually consuming them.
"""
from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]  # fluffychat/
SCRIPT = REPO / "scripts" / "abi-matrix.py"
WORKFLOW = REPO.parent / ".github" / "workflows" / "build-fluffychat.yml"

_spec = importlib.util.spec_from_file_location("abi_matrix", SCRIPT)
assert _spec is not None and _spec.loader is not None, SCRIPT
mx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mx)


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True
    )


def parse(output: str) -> dict[str, str]:
    """`KEY=value` lines as CI appends them to $GITHUB_OUTPUT."""
    result = {}
    for line in output.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            result[key.strip()] = value.strip()
    return result


class DevIsArm64Only(unittest.TestCase):
    """The whole point: one ABI, no leftovers from the three-ABI build."""

    def setUp(self):
        self.out = parse(run("--ref", "v2.11.3-plotina-mobile.35-dev.3").stdout)

    def test_mode_is_dev(self):
        self.assertEqual(self.out["MODE"], "dev")

    def test_dart_aot_is_arm64_only(self):
        self.assertEqual(self.out["DART_PLATFORMS"], "android-arm64")

    def test_denoiser_is_built_for_arm64_only(self):
        self.assertEqual(self.out["CARGO_NDK_TARGETS"], "arm64-v8a")
        self.assertEqual(self.out["RUST_TARGETS"], "aarch64-linux-android")

    def test_one_apk_named_as_before(self):
        self.assertEqual(self.out["APK_FILES"], "Plotina-Mobile.apk")
        self.assertEqual(self.out["ABI_PAIRS"], "Plotina-Mobile.apk arm64-v8a")

    def test_the_other_abis_must_not_be_built_at_all(self):
        # Not merely "not uploaded": the card asks for the compile to be gone.
        self.assertEqual(self.out["MUST_NOT_BUILD_ABIS"], "armeabi-v7a x86_64")
        compiled = " ".join(
            self.out[key]
            for key in (
                "DART_PLATFORMS",
                "CARGO_NDK_TARGETS",
                "RUST_TARGETS",
                "APK_FILES",
                "ABI_PAIRS",
            )
        )
        for abi in ("armeabi-v7a", "x86_64", "android-arm,", "android-x64"):
            self.assertNotIn(abi, compiled, f"{abi} leaked into the dev build")

    def test_dev_build_number_form_is_also_dev(self):
        out = parse(run("--dev-build", "4").stdout)
        self.assertEqual(out["MODE"], "dev")
        self.assertEqual(out["DART_PLATFORMS"], "android-arm64")


class StableKeepsThreeAbis(unittest.TestCase):
    """Nothing may change for users of a released tag."""

    def setUp(self):
        self.out = parse(run("--ref", "v2.11.3-plotina-mobile.35").stdout)

    def test_mode_is_stable(self):
        self.assertEqual(self.out["MODE"], "stable")

    def test_dart_aot_keeps_all_three(self):
        # Order is Flutter's business; the set is the contract.
        self.assertEqual(
            sorted(self.out["DART_PLATFORMS"].split(",")),
            ["android-arm", "android-arm64", "android-x64"],
        )

    def test_denoiser_keeps_all_three_targets(self):
        self.assertEqual(
            self.out["CARGO_NDK_TARGETS"], "arm64-v8a armeabi-v7a x86_64"
        )
        self.assertEqual(
            self.out["RUST_TARGETS"],
            "aarch64-linux-android,armv7-linux-androideabi,x86_64-linux-android",
        )

    def test_both_published_apks_are_still_built(self):
        self.assertEqual(
            self.out["APK_FILES"], "Plotina-Mobile.apk Plotina-Mobile-armv7.apk"
        )
        self.assertEqual(
            self.out["ABI_PAIRS"],
            "Plotina-Mobile.apk arm64-v8a Plotina-Mobile-armv7.apk armeabi-v7a",
        )
        self.assertEqual(self.out["MUST_NOT_BUILD_ABIS"], "")

    def test_an_untagged_dispatch_is_a_stable_build(self):
        # `workflow_dispatch` on a branch is how the stable path is proven
        # without touching a release; it must not fall into arm64-only.
        for ref in ("main", "wt/mobile-arm64-dev", "", "v1.2.3"):
            with self.subTest(ref=ref):
                out = parse(run("--ref", ref).stdout)
                self.assertEqual(out["MODE"], "stable")
                self.assertIn("armeabi-v7a", out["ABI_PAIRS"])


class TheListsAgreeWithEachOther(unittest.TestCase):
    """Every ABI that gets an APK must have been compiled, and vice versa."""

    def test_published_abis_are_compiled(self):
        for mode_arg in (["--ref", "v2.11.3-plotina-mobile.35-dev.1"],
                         ["--ref", "v2.11.3-plotina-mobile.35"]):
            with self.subTest(mode_arg=mode_arg):
                out = parse(run(*mode_arg).stdout)
                compiled = out["CARGO_NDK_TARGETS"].split()
                pairs = out["ABI_PAIRS"].split()
                published = pairs[1::2]
                must_not = out["MUST_NOT_BUILD_ABIS"].split()
                self.assertTrue(published)
                self.assertLessEqual(set(published), set(compiled))
                # A forbidden ABI must not be compiled either -- that is what
                # makes the dev build cheaper rather than only smaller.
                self.assertFalse(set(must_not) & set(compiled))
                self.assertEqual(len(pairs) % 2, 0)
                self.assertEqual(len(out["APK_FILES"].split()), len(published))
                # One platform per compiled ABI, and one rust target each.
                self.assertEqual(
                    len(out["DART_PLATFORMS"].split(",")), len(compiled)
                )
                self.assertEqual(len(out["RUST_TARGETS"].split(",")), len(compiled))
                self.assertEqual(len(set(compiled)), len(compiled))

    def test_apk_names_match_the_workflow_env(self):
        # The workflow spells the same two file names in its `env:` block; a
        # rename in one place and not the other would publish an APK under a
        # name the updater does not look for.
        text = WORKFLOW.read_text(encoding="utf-8")
        names = dict(re.findall(r"^\s{2}(APK_NAME[A-Z0-9_]*): (\S+)$", text, re.M))
        self.assertEqual(names.get("APK_NAME"), mx.APK_NAME["arm64-v8a"])
        self.assertEqual(names.get("APK_NAME_ARMV7"), mx.APK_NAME["armeabi-v7a"])

    def test_unknown_abi_is_refused(self):
        with self.assertRaises(SystemExit):
            mx.apk_name("riscv64")


class WorkflowConsumesTheMatrix(unittest.TestCase):
    """The ABI lists live in one place; each step asks the matrix for them."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_the_matrix_step_runs_before_the_toolchain(self):
        self.assertIn("abi-matrix.py", self.text)
        matrix_at = self.text.index("abi-matrix.py")
        self.assertLess(matrix_at, self.text.index("dtolnay/rust-toolchain"))
        self.assertLess(matrix_at, self.text.index("flutter build apk"))

    def test_denoiser_targets_are_not_spelled_out(self):
        problem = hardcoded_denoiser_targets(self.text)
        self.assertIsNone(problem)
        # Negative control: the same predicate must reject the old line, or it
        # would keep passing after a rewrite that reintroduced three ABIs.
        old = self.text.replace(
            "cargo ndk \\\n            $CARGO_NDK_TARGETS \\",
            "cargo ndk \\\n            -t arm64-v8a -t armeabi-v7a -t x86_64 \\",
        )
        self.assertNotEqual(old, self.text, "the cargo ndk call moved; update this test")
        self.assertIsNotNone(hardcoded_denoiser_targets(old))

    def test_build_apk_takes_its_platforms_from_the_matrix(self):
        self.assertIn('--target-platform "$DART_PLATFORMS"', self.text)
        self.assertIn("--split-per-abi", self.text)

    def test_no_step_loops_over_a_hardcoded_apk_pair(self):
        # "both APKs" loops must come from $APK_FILES / $ABI_PAIRS, otherwise
        # the armv7 file is required even when it was never built.
        occurrences = len(re.findall(r'\$APK_NAME" "\$APK_NAME_ARMV7', self.text))
        self.assertEqual(occurrences, 0)


def hardcoded_denoiser_targets(text: str) -> str | None:
    """Return the offending snippet when the denoiser step pins three ABIs."""
    match = re.search(r"cargo ndk[^\n]*\n?[^\n]*-t [^\n]*", text)
    if not match:
        return None
    snippet = match.group(0)
    return snippet if "-t arm64-v8a -t armeabi-v7a -t x86_64" in snippet else None


if __name__ == "__main__":
    unittest.main()
