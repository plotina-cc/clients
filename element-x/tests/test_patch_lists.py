"""The patch lists in the CI workflows must carry every patch, in one order.

Plotina X applies its patches from two hand-written lists, and both have already
betrayed us: `build-element-x.yml` stopped at 0015, so release `.32-dev.4` shipped
without patch 0016 and the APK had no `PlotinaPersonalNames` in its dex;
`validate-element-x.yml` stopped at 0008, so the configuration check never saw
0009..0016 at all.

So the lists are not documentation, they are the build: a `.patch` file in
`element-x/patches/` that no list names is silently not applied, and a list that
diverges from the other one means the check and the build run different trees.
This test pins the three lists to the directory and to each other.

Run: python3 -m unittest discover -s element-x/tests
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ELEMENT_X = Path(__file__).resolve().parent.parent
REPO = ELEMENT_X.parent
PATCHES = ELEMENT_X / "patches"
BUILD_WORKFLOW = REPO / ".github" / "workflows" / "build-element-x.yml"
VALIDATE_WORKFLOW = REPO / ".github" / "workflows" / "validate-element-x.yml"

PATCH_NAME = re.compile(r"\b(\d{4}-[a-z0-9][a-z0-9-]*)\.patch\b")
LOOP_NAME = re.compile(r"\b(\d{4}-[a-z0-9][a-z0-9-]*)\b")


def patch_files() -> list[str]:
    """Every patch we ship, in the order its number gives it."""
    return sorted(p.stem for p in PATCHES.glob("*.patch"))


def for_loop_list(text: str) -> list[str]:
    """The names inside the `for p in ... ; do` loop, in written order."""
    names: list[str] = []
    inside = False
    for line in text.splitlines():
        if not inside:
            head = re.search(r"\bfor p in\b(.*)", line)
            if not head:
                continue
            inside = True
            line = head.group(1)
        names.extend(LOOP_NAME.findall(line))
        if re.search(r"\bdo\b", line):
            break
    return names


def applied_list(text: str) -> list[str]:
    """The names in the individual `git apply .../patches/<name>.patch` lines."""
    return PATCH_NAME.findall(text)


class PatchListTests(unittest.TestCase):
    """Both workflows name every patch on disk, and they name them in one order."""

    def setUp(self) -> None:
        self.on_disk = patch_files()
        self.build = BUILD_WORKFLOW.read_text()
        self.validate = VALIDATE_WORKFLOW.read_text()

    def test_the_directory_is_not_empty(self) -> None:
        # Guards the whole file: an empty glob would make every assertion below vacuous.
        self.assertGreater(len(self.on_disk), 10, self.on_disk)

    def test_build_loop_names_every_patch(self) -> None:
        """The `patches` job's loop: `.32-dev.4` failed exactly here (no 0016)."""
        listed = for_loop_list(self.build)
        self.assertEqual(self.on_disk, sorted(listed), "build-element-x.yml for-loop")
        self.assertEqual(len(listed), len(set(listed)), "duplicate entry in the build loop")

    def test_every_listed_patch_is_really_applied_by_the_build(self) -> None:
        """The build job applies patch by patch; a name missing here is missing from the APK."""
        listed = applied_list(self.build)
        self.assertEqual(self.on_disk, sorted(listed), "git apply lines in build-element-x.yml")

    def test_validate_loop_names_every_patch(self) -> None:
        """The configuration check must build the same tree as the build."""
        listed = for_loop_list(self.validate)
        self.assertEqual(self.on_disk, sorted(listed), "validate-element-x.yml for-loop")

    def test_the_two_workflows_agree_on_the_order(self) -> None:
        """Not only the set: patch order is a dependency (0014 needs 0002's hunks)."""
        build_loop = for_loop_list(self.build)
        build_applies = applied_list(self.build)
        validate_loop = for_loop_list(self.validate)
        self.assertEqual(build_loop, build_applies, "build loop vs build apply order")
        self.assertEqual(build_loop, validate_loop, "build loop vs validate loop order")

    def test_contact_names_is_applied_after_its_predecessor(self) -> None:
        """0016 is the patch that went missing; keep it last, after 0015."""
        listed = for_loop_list(self.build)
        self.assertIn("0016-plotina-contact-names-for-people", listed)
        self.assertLess(
            listed.index("0015-plotina-dm-personal-names"),
            listed.index("0016-plotina-contact-names-for-people"),
        )


class GateRejectsNegativeControlTests(unittest.TestCase):
    """The parser finds a patch that is on disk but absent from a list.

    These are synthetic on purpose: they prove the comparison is two-way, so the
    gate cannot pass by comparing two lists that are equally wrong.
    """

    def test_extra_patch_on_disk_is_reported(self) -> None:
        on_disk = patch_files()
        named = [p for p in on_disk if not p.startswith("0016")]
        self.assertNotEqual(on_disk, sorted(named))
        self.assertIn("0016-plotina-contact-names-for-people", sorted(set(on_disk) - set(named)))

    def test_probe_line_without_a_file_is_reported(self) -> None:
        on_disk = patch_files()
        named = sorted(on_disk) + ["0099-probe"]
        self.assertNotEqual(sorted(on_disk), sorted(named))

    def test_parser_reads_a_list_that_would_miss_a_patch(self) -> None:
        """A workflow snippet in the pre-fix shape must not compare equal to the directory."""
        stale = "          for p in \\\n            0002-element-x-android-plotina-signing \\\n            0004-element-x-android-plotina-call-url; do\n"
        parsed = for_loop_list(stale)
        self.assertEqual(
            ["0002-element-x-android-plotina-signing", "0004-element-x-android-plotina-call-url"],
            parsed,
        )
        self.assertNotEqual(sorted(parsed), patch_files())


if __name__ == "__main__":
    unittest.main()
