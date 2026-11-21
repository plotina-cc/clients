#!/usr/bin/env python3
"""The Plotina dart tests run in exactly one place: the `dart-tests` job.

A dart test step inside `apk` is not a correctness problem, it is a *cost*
problem that looks green: the same 140 tests run a second time, serially, in
front of a 20-minute Gradle build, so every release waits for them twice. It
was added as a step there first and stayed behind when the parallel job was
introduced (run 44928660451: `Run the Plotina Dart tests` 99 s inside
`Android APK`, on top of the `Dart tests` job that had already finished).

So the contract this pins is a count and a location:

  * `Run the Plotina Dart tests` appears exactly once in the whole workflow;
  * that one occurrence is inside the `dart-tests` job, never inside `apk`;
  * the `apk` job has no `flutter test` at all — the step name is not the
    contract, the command is, and a renamed serial step must fail here too;
  * `dart-tests` still has no `needs:`, because the saving only exists while
    the job runs *beside* the build rather than after it.

Run: python3 -m unittest discover -s fluffychat/tests -p 'test_*.py' -v
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[2]
    / ".github"
    / "workflows"
    / "build-fluffychat.yml"
)

STEP_NAME = "Run the Plotina Dart tests"


def block_of(lines: list[str], start: int) -> list[str]:
    """The lines of the YAML block that opens at `start` (deeper indent, plus
    the line itself)."""
    indent = len(lines[start]) - len(lines[start].lstrip())
    body = [lines[start]]
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if not stripped:
            body.append(line)
            continue
        if len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line)
    return body


def job(lines: list[str], name: str) -> list[str]:
    """The lines of `  <name>:` under `jobs:`; empty when the job is absent."""
    header = re.compile(rf"^  {re.escape(name)}:\s*$")
    for index, line in enumerate(lines):
        if header.match(line):
            return block_of(lines, index)
    return []


def offending(job_text: str, needle: str) -> str:
    """Only the lines that mention `needle` — a failure message must not paste a
    50 KB job block into the CI log."""
    hits = [line.strip() for line in job_text.splitlines() if needle in line]
    return "\n".join(hits) if hits else "(no line mentions it)"


class DartTestsRunOnce(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.lines = cls.text.splitlines()
        cls.apk = "\n".join(job(cls.lines, "apk"))
        cls.dart_tests = "\n".join(job(cls.lines, "dart-tests"))

    def test_the_job_this_test_is_about_exists(self) -> None:
        # A rename that empties `job()` would make every assertion below pass
        # vacuously — the count would be 1 for a step that no longer exists.
        self.assertTrue(self.dart_tests.strip(), "no `dart-tests` job in the workflow")
        self.assertTrue(self.apk.strip(), "no `apk` job in the workflow")
        self.assertIn(STEP_NAME, self.dart_tests, "the parallel job lost its test step")
        self.assertIn("flutter test", self.dart_tests, "the parallel job no longer runs flutter test")

    def test_the_step_appears_exactly_once(self) -> None:
        count = self.text.count(STEP_NAME)
        self.assertEqual(
            count,
            1,
            f"{STEP_NAME!r} appears {count} time(s) in the workflow; the second run is "
            "serial wall-clock on every release. Occurrences:\n"
            + "\n".join(
                f"  line {i}: {line.strip()}"
                for i, line in enumerate(self.lines, 1)
                if STEP_NAME in line
            ),
        )

    def test_the_step_is_not_in_the_apk_job(self) -> None:
        # Not `assertNotIn`: unittest pastes the whole container into the
        # failure message, and the apk job is 50 KB of YAML.
        if STEP_NAME in self.apk:
            self.fail(
                "the APK job runs the dart tests a second time, in front of Build APK:\n"
                + offending(self.apk, STEP_NAME)
            )

    def test_the_apk_job_runs_no_flutter_test(self) -> None:
        # The step name is not the contract — the command is. A serial test run
        # under any name costs the same wall-clock.
        found = re.search(r"(?m)^\s*(?:-\s*)?(?:run:.*)?flutter test\b", self.apk)
        if found:
            self.fail(
                "the APK job still calls `flutter test` at "
                f"line {found.group(0).strip()!r}; the tests belong to `dart-tests` only:\n"
                + offending(self.apk, "flutter test")
            )

    def test_dart_tests_still_runs_beside_the_build(self) -> None:
        # A `needs:` here would serialise the suite behind the build and give
        # back the wall-clock this job was created to save.
        if re.search(r"(?m)^\s+needs:", self.dart_tests):
            self.fail(
                "`dart-tests` gained a `needs:`; it must stay a sibling of `apk`:\n"
                + offending(self.dart_tests, "needs:")
            )


if __name__ == "__main__":
    unittest.main()
