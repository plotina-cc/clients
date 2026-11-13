"""The Element Call archive must never become GitHub's "latest" release (t_ce39efd5).

`build-element-call.yml` publishes its tarball with
`softprops/action-gh-release`. Without an explicit `prerelease:` that action
creates a *full* release, and GitHub then points `releases/latest` at it — which
is how `v0.26.1-plotina-call.17`, an intermediate archive of our own call
frontend, took the "latest" badge away from the stable client.

Element Call has no dev series: every `v<upstream>-plotina-call.N` tag is one of
our internal archives and none of them is a stable client release. So the flag
has to be the literal `true`, not a condition on the tag the way X does it
(`contains(github.ref_name, '-dev.')`) — for EC that expression is false for
every tag we will ever push, which is the bug this module keeps out.

* ``PublishStepTests`` reads the shipped workflow and asserts the publish step
  sets `prerelease: true`.
* ``CheckerTests`` prove that assertion is not decoration: a publish step with
  no `prerelease`, with `prerelease: false`, with a tag-dependent expression, a
  workflow with no publish step at all, and one where `prerelease: true` sits in
  a *neighbouring* step must all be rejected. The step is located by its
  `uses:` line plus the block's indentation, so a key belonging to another step
  cannot satisfy the check.

Run: python3 -m unittest discover -s element-call/tests -p 'test_*.py'
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
WORKFLOW = REPO / ".github" / "workflows" / "build-element-call.yml"

PUBLISH_ACTION = "softprops/action-gh-release"


def _steps(workflow_text: str) -> list[list[str]]:
    """Split a workflow into step blocks: a `- ` item and every line indented under it.

    Not a YAML parser (the runner's interpreter may lack PyYAML, and preflight
    owns the parse check). Enough structure to tell one step's keys from the
    next step's, which is all this test needs.
    """
    lines = workflow_text.splitlines()
    blocks: list[list[str]] = []
    i = 0
    while i < len(lines):
        dash = re.match(r"^(\s*)-(\s|$)", lines[i])
        if not dash:
            i += 1
            continue
        indent = len(dash.group(1))
        block = [lines[i]]
        i += 1
        while i < len(lines):
            line = lines[i]
            if line.strip() and len(line) - len(line.lstrip(" ")) <= indent:
                break
            block.append(line)
            i += 1
        blocks.append(block)
    return blocks


def publish_step(workflow_text: str) -> list[str] | None:
    """The step that runs `softprops/action-gh-release`, or None."""
    for block in _steps(workflow_text):
        for line in block:
            code = line.split("#", 1)[0]
            if PUBLISH_ACTION in code:
                return block
    return None


def publish_step_problems(workflow_text: str) -> list[str]:
    """Every reason the publish step would let GitHub mark the archive latest."""
    block = publish_step(workflow_text)
    if block is None:
        return [f"no step uses {PUBLISH_ACTION}: nothing publishes the archive"]

    values = []
    for line in block:
        match = re.match(r"^\s+prerelease:\s*(.*?)\s*$", line.split("#", 1)[0])
        if match:
            values.append(match.group(1))

    if not values:
        return [
            f"the {PUBLISH_ACTION} step sets no `prerelease:', so every EC tag becomes"
            " releases/latest and hides the stable client"
        ]

    problems = []
    for value in values:
        if value != "true":
            problems.append(
                f"the publish step sets `prerelease: {value}', not the literal `true':"
                " the EC archive is an intermediate artifact and must never be latest"
            )
    return problems


HEAD = """\
name: Build Plotina Call

on:
  push:
    tags: ["v*-plotina-call.*"]

jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: plotina-call
"""


def workflow_with(publish_lines: list[str]) -> str:
    """HEAD plus one step, whose body lines are given already indented."""
    return HEAD + "".join(line + "\n" for line in publish_lines)


def publish_step_with(*with_lines: str) -> list[str]:
    lines = ["      - uses: softprops/action-gh-release@v2", "        with:",
             "          files: dist/plotina-element-call.tar.gz"]
    lines.extend("          " + line for line in with_lines)
    return lines


class PublishStepTests(unittest.TestCase):
    """The workflow we actually ship."""

    def setUp(self) -> None:
        self.assertTrue(
            WORKFLOW.is_file(), f"build-element-call.yml is missing at {WORKFLOW}"
        )
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_the_publish_step_is_found(self) -> None:
        # Guards the check itself: a rename of the action must fail loudly here
        # instead of silently vacuously passing the assertion below.
        self.assertIsNotNone(publish_step(self.text))

    def test_publish_step_marks_the_release_prerelease(self) -> None:
        self.assertEqual(publish_step_problems(self.text), [])


class CheckerTests(unittest.TestCase):
    """Negative controls: what the check must reject."""

    def test_prerelease_true_is_accepted(self) -> None:
        text = workflow_with(publish_step_with("prerelease: true"))
        self.assertEqual(publish_step_problems(text), [])

    def test_missing_prerelease_is_rejected(self) -> None:
        text = workflow_with(publish_step_with())
        problems = publish_step_problems(text)
        self.assertTrue(problems, "a publish step without prerelease passed the check")
        self.assertIn("prerelease", problems[0])

    def test_prerelease_false_is_rejected(self) -> None:
        text = workflow_with(publish_step_with("prerelease: false"))
        problems = publish_step_problems(text)
        self.assertTrue(problems, "prerelease: false passed the check")
        self.assertIn("false", problems[0])

    def test_tag_dependent_prerelease_is_rejected(self) -> None:
        # X's shape, copied into EC: contains(github.ref_name, '-dev.') is false
        # for every EC tag, so the archive would be a full release again.
        text = workflow_with(
            publish_step_with("prerelease: ${{ contains(github.ref_name, '-dev.') }}")
        )
        problems = publish_step_problems(text)
        self.assertTrue(problems, "a tag-dependent prerelease passed the check")
        self.assertIn("-dev.", problems[0])

    def test_prerelease_in_a_neighbouring_step_is_not_enough(self) -> None:
        text = HEAD.replace(
            "      - uses: actions/download-artifact@v4\n"
            "        with:\n"
            "          name: plotina-call\n",
            "      - uses: actions/download-artifact@v4\n"
            "        with:\n"
            "          name: plotina-call\n"
            "          prerelease: true\n",
        )
        text += "".join(line + "\n" for line in publish_step_with())
        self.assertIn("prerelease: true", text)
        problems = publish_step_problems(text)
        self.assertTrue(
            problems, "a prerelease key from another step satisfied the check"
        )

    def test_workflow_without_a_publish_step_is_rejected(self) -> None:
        problems = publish_step_problems(HEAD)
        self.assertTrue(problems, "a workflow without a publish step passed the check")
        self.assertIn(PUBLISH_ACTION, problems[0])


if __name__ == "__main__":
    unittest.main()
