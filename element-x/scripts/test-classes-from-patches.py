#!/usr/bin/env python3
"""Derive, from element-x/patches/, which Gradle test tasks CI has to run and how many cases each
Plotina test class contributes.

The patch set is the source of truth: every `+++ b/<path>` in a patch that lands in a
`src/test/kotlin/` tree is a test file our layer owns, and every added `@Test` in it is a case CI is
supposed to run. Deriving the list here rather than hard-coding it in the workflow means a new
patch with a new test module needs no workflow edit, and a patch that loses its tests shows up as a
smaller expectation instead of silently shrinking what CI checks.

Usage:
    test-classes-from-patches.py [<patches dir>] [--tasks-out FILE] [--expectations-out FILE]

Without the output flags it prints both sections on stdout: the per-class expectation lines, then
`TASKS="<gradle task> ..."`. With `--expectations-out` the class lines go to that file, in the form
check-test-results.sh reads:

    <gradle module path> <test class FQN> <expected test count>

A module path is the part of the test file's path before `/src/test/kotlin/`:
`app/src/test/kotlin/...` is `:app`, `libraries/matrix/api/src/test/kotlin/...` is
`:libraries:matrix:api`. A file with no added `@Test` (a shared fixture) is skipped.

A class touched by several patches gets the largest single contribution, not the sum: the patches
are cumulative, so 0016 appending to a class 0015 created still executes the file once.
"""

import argparse
import re
import sys
from pathlib import Path

TEST_ROOT = "/src/test/kotlin/"
ADDED_TEST = re.compile(r"^\+\s*@Test\b")


def parse(patch: Path) -> dict[tuple[str, str], int]:
    """Return {(module, class FQN): added @Test count} for the test files this patch writes."""
    counts: dict[tuple[str, str], int] = {}
    current: tuple[str, str] | None = None
    with patch.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("+++ "):
                current = None
                path = line[4:].strip()
                if not path.startswith("b/"):
                    continue  # a deleted file (/dev/null): nothing to run
                path = path[2:]
                if TEST_ROOT not in path or not path.endswith(".kt"):
                    continue
                module, _, rest = path.partition(TEST_ROOT)
                if not _looks_like_module(module):
                    continue
                fqn = rest[: -len(".kt")].replace("/", ".")
                current = (module, fqn)
                counts.setdefault(current, 0)
                continue
            if current is not None and ADDED_TEST.match(line):
                counts[current] += 1
    return counts


def _looks_like_module(prefix: str) -> bool:
    """A module prefix is a relative directory path (`libraries/matrix/api`), never a bare name."""
    if not prefix or prefix.startswith("/") or ".." in prefix.split("/"):
        return False
    # `app` is the one module whose Gradle path is the directory itself; everything else lives at
    # least one level down (features/, libraries/, services/), so a single segment other than `app`
    # is a path fragment, not a module.
    return "/" in prefix or prefix == "app"


def gradle_task(module: str) -> str:
    """The unit-test task name for a module.

    `app` has store flavours, so its unit tests are flavour-qualified; `gplay` is the flavour the
    release APK is built from and the one whose variant carries the Firebase push provider.
    Every library and feature module has a single `debug` variant.
    """
    if module == "app":
        return ":app:testGplayDebugUnitTest"
    return f":{gradle_path(module)}:testDebugUnitTest"


def gradle_path(module: str) -> str:
    """A directory path as a Gradle project path: `features/home/impl` -> `features:home:impl`."""
    return module.replace("/", ":")


def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="Derive the Gradle test tasks and test counts from patches/")
    ap.add_argument("patches_dir", nargs="?", default=str(here.parent / "patches"))
    ap.add_argument("--tasks-out", help="write the space-separated Gradle task list here")
    ap.add_argument("--expectations-out", help="write the per-class expectations here")
    args = ap.parse_args()

    patches_dir = Path(args.patches_dir)
    if not patches_dir.is_dir():
        print(f"::error::no patches directory: {patches_dir}", file=sys.stderr)
        return 1

    # LC_ALL=C order, the order apply-patches.sh applies them in.
    files = sorted(patches_dir.glob("*.patch"), key=lambda p: p.name.encode())
    if not files:
        print(f"::error::{patches_dir} holds no .patch files", file=sys.stderr)
        return 1

    best: dict[tuple[str, str], int] = {}
    for patch in files:
        for key, n in parse(patch).items():
            best[key] = max(best.get(key, 0), n)

    classes = {key: n for key, n in best.items() if n > 0}
    if not classes:
        print("::error::the patch set adds no @Test cases", file=sys.stderr)
        return 1

    modules = sorted({module for module, _ in classes})
    tasks = [gradle_task(m) for m in modules]

    lines = "".join(f":{gradle_path(m)} {fqn} {n}\n" for (m, fqn), n in sorted(classes.items()))
    if args.expectations_out:
        Path(args.expectations_out).write_text(lines, encoding="utf-8")
    if args.tasks_out:
        Path(args.tasks_out).write_text(" ".join(tasks) + "\n", encoding="utf-8")
    if not args.expectations_out:
        sys.stdout.write(lines)
    if not args.tasks_out:
        print("TASKS=" + " ".join(tasks))

    print(
        f"{len(classes)} class(es), {sum(classes.values())} test(s) across {len(modules)} module(s)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
