#!/usr/bin/env python3
"""Runs the workflow's "Build APK" step body for real, with a fake `flutter`.

The step is more than one command now: it builds, copies the APKs the mode
publishes, and fails when an ABI the matrix forbids was compiled anyway.  A
unit test of abi-matrix.py cannot see any of that — the first wired version
copied the APK correctly and then died on `ls -lh $APK_FILES` because the step
runs with `working-directory: fluffychat/upstream` while the copied files live
in `$GITHUB_WORKSPACE`.  So this test extracts the step body from the workflow,
runs it under bash with a fake `flutter` that produces the splits the matrix
asks for, and checks the result.

No PyYAML: the body is taken by indentation (`run: |` and the lines under it),
which is all the extraction needs and keeps the test dependency-free for CI.

Run: python3 -m unittest discover -s fluffychat/tests -p 'test_*.py' -v
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]  # fluffychat/
WORKFLOW = REPO.parent / ".github" / "workflows" / "build-fluffychat.yml"
MATRIX = REPO / "scripts" / "abi-matrix.py"

STEP_NAME = "Build APK"


def step_body(name: str) -> str:
    """The `run:` script of the step called `name`, dedented."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = next(
        i for i, line in enumerate(lines) if line.strip() == f"- name: {name}"
    )
    run_at = None
    for i in range(start + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped.startswith("- name:"):
            break
        if stripped == "run: |":
            run_at = i
            break
    if run_at is None:
        raise AssertionError(f"step {name!r} has no `run: |` body")
    indent = len(lines[run_at]) - len(lines[run_at].lstrip())
    body = []
    for line in lines[run_at + 1 :]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line[indent + 2 :] if line.strip() else "")
    return textwrap.dedent("\n".join(body)) + "\n"


def matrix(ref_or_dev: dict[str, str]) -> dict[str, str]:
    args = []
    for key, value in ref_or_dev.items():
        args += [key, value]
    out = subprocess.run(
        [sys.executable, str(MATRIX), *args], capture_output=True, text=True, check=True
    ).stdout
    result = {}
    for line in out.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            result[key.strip()] = value.strip()
    return result


FAKE_FLUTTER = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
if [ "${1:-}" = "build" ]; then
  mkdir -p build/app/outputs/flutter-apk
  IFS=',' read -ra PLATFORMS <<< "${DART_PLATFORMS:-}"
  for platform in "${PLATFORMS[@]}"; do
    case "$platform" in
      android-arm64) abi=arm64-v8a ;;
      android-arm) abi=armeabi-v7a ;;
      android-x64) abi=x86_64 ;;
      *) echo "fake flutter: unknown platform $platform" >&2; exit 1 ;;
    esac
    printf 'fake apk for %s\\n' "$abi" > "build/app/outputs/flutter-apk/app-$abi-release.apk"
  done
  for extra in ${FAKE_EXTRA_ABIS:-}; do
    printf 'stray apk\\n' > "build/app/outputs/flutter-apk/app-$extra-release.apk"
  done
fi
exit 0
"""


class BuildApkStep(unittest.TestCase):
    """The step end to end: what it copies, and what it refuses to accept."""

    def run_step(self, matrix_args: dict[str, str], extra_abis: str = "") -> tuple[
        subprocess.CompletedProcess, Path, list[str]
    ]:
        work = Path(tempfile.mkdtemp(prefix="build-apk-step-"))
        workspace = work / "workspace"
        upstream = work / "fluffychat" / "upstream"
        fake_bin = work / "bin"
        (upstream / "android").mkdir(parents=True)
        workspace.mkdir()
        fake_bin.mkdir()
        log = work / "flutter.log"
        flutter = fake_bin / "flutter"
        flutter.write_text(FAKE_FLUTTER, encoding="utf-8")
        flutter.chmod(0o755)

        values = matrix(matrix_args)
        body = step_body(STEP_NAME)
        # The `${{ }}` expressions CI substitutes before bash sees the script.
        body = (
            body.replace("${{ steps.signing.outputs.variant }}", "release")
            .replace("${{ steps.versioncode.outputs.version_code }}", "2110335")
            .replace("${{ steps.versioncode.outputs.version_name }}", "2.11.3-dev.3")
            .replace("${{ steps.versioncode.outputs.dev }}", values["MODE"] == "dev" and "3" or "")
        )
        script = work / "step.sh"
        script.write_text(body, encoding="utf-8")

        env = {
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "HOME": os.environ.get("HOME", "/tmp"),
            "GITHUB_WORKSPACE": str(workspace),
            "GITHUB_RUN_NUMBER": "440",
            "SENTRY_DSN": "",
            "SENTRY_RELEASE": "fluffy@2.11.3+v2.11.3-plotina-mobile.35-dev.3",
            "DART_PLATFORMS": values["DART_PLATFORMS"],
            "ABI_PAIRS": values["ABI_PAIRS"],
            "APK_FILES": values["APK_FILES"],
            "MUST_NOT_BUILD_ABIS": values["MUST_NOT_BUILD_ABIS"],
            "FAKE_LOG": str(log),
            "FAKE_EXTRA_ABIS": extra_abis,
        }
        result = subprocess.run(
            ["bash", str(script)], cwd=upstream, env=env, capture_output=True, text=True
        )
        args = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
        return result, workspace, args

    def test_dev_build_copies_one_arm64_apk(self):
        # The regression: this step copied the APK and then ran `ls $APK_FILES`
        # in fluffychat/upstream, where the copied file is not, and died.
        result, workspace, args = self.run_step({"--ref": "v2.11.3-plotina-mobile.35-dev.3"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(sorted(p.name for p in workspace.glob("*.apk")), ["Plotina-Mobile.apk"])
        self.assertIn("Plotina-Mobile.apk", result.stdout)
        build = next(line for line in args if line.startswith("build apk"))
        self.assertIn("--split-per-abi", build)
        self.assertIn("--target-platform android-arm64", build)
        self.assertIn("--build-number 2110335", build)
        self.assertIn("--build-name 2.11.3-dev.3", build)

    def test_dev_build_refuses_a_stray_split(self):
        # Negative control: if Gradle ignores the platform list and compiles
        # armv7 anyway, the whole saving is a lie and the step must go red.
        result, workspace, _ = self.run_step(
            {"--ref": "v2.11.3-plotina-mobile.35-dev.3"}, extra_abis="armeabi-v7a"
        )
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("must not compile armeabi-v7a", result.stdout + result.stderr)
        self.assertEqual(list(workspace.glob("*.apk")), [])

    def test_stable_build_copies_both_published_apks(self):
        result, workspace, args = self.run_step({"--ref": "v2.11.3-plotina-mobile.35"})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(
            sorted(p.name for p in workspace.glob("*.apk")),
            ["Plotina-Mobile-armv7.apk", "Plotina-Mobile.apk"],
        )
        # x86_64 was compiled (emulators keep it) but is never published.
        self.assertTrue((workspace.parent / "fluffychat" / "upstream").is_dir())
        build = next(line for line in args if line.startswith("build apk"))
        self.assertIn("--target-platform android-arm64,android-arm,android-x64", build)
        # The dev name must not leak into a stable build.
        self.assertNotIn("--build-name", build)


if __name__ == "__main__":
    unittest.main()
