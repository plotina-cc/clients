#!/usr/bin/env python3
"""Puts Plotina's dart tests into a patched FluffyChat checkout, and gates the
`flutter test` run on both the outcome and the number of tests that ran.

Why this exists as a script with three subcommands instead of one `flutter test`
line in the workflow:

  * the set of our tests is spread over two places — `fluffychat/tests/*_test.dart`
    in this repository, and the files our patches plant under `upstream/test/`
    (0016/0020/0023-0027). A hardcoded list drifts from the patches the moment a
    patch is renumbered, and `flutter test test` is not an option at all: upstream
    keeps suites that fail on a patched tree for reasons that are not ours
    (`test/screenshots/chat_list_test.dart` needs libvodozemac_bindings_dart.so).
    So the list is *derived* — from our repo copies and from the patches' own
    `+++ b/test/...` headers — and a patch that stops planting a test fails here
    instead of quietly shrinking the suite.
  * `flutter test` dies on a tree that has no DeepFilterNet3 model
    (`Error detected in pubspec.yaml: No file or variants found for asset`), and
    that 7.6 MiB asset is fetched, not committed. `precheck` turns that into one
    line that names `fluffychat/scripts/fetch-model.sh` instead of a mystery from
    inside the Dart toolchain. It fails, it never skips.
  * a green `flutter test` is not proof that our tests ran. `gate` reads the
    counter out of the log and fails below a floor, so a suite that lost files
    cannot look green — and a log with no counter at all (flutter died early)
    fails instead of passing vacuously.

Usage (from any directory; paths are resolved from the repository root):

  plotina-dart-tests.py stage    --repo <fluffychat/> --upstream <tree>
      prints one tree-relative test path per line, ready to hand to `flutter test`
  plotina-dart-tests.py precheck --repo <fluffychat/> --upstream <tree>
  plotina-dart-tests.py gate     --log <flutter-test.log> [--min 60]

Exit status: 0 on success, 1 on a rejected run, 2 on bad usage.
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

# Where our repository copies are planted inside the upstream tree. A separate
# directory on purpose: nothing upstream lives here, so `git status` in the tree
# stays readable and a future `git clean` cannot delete a file we wrote.
STAGING_DIR = "test/plotina_ci"

# `+++ b/test/...` in a unified diff, i.e. a file the patch creates or replaces.
PATCH_TEST_HEADER = re.compile(r"^\+\+\+ b/(test/.+\.dart)\s*$", re.MULTILINE)

# One `flutter test` progress line: `00:12 +59 ~2 -1: path: case name`.
COUNTER = re.compile(r"\+(\d+)(?: ~(\d+))?(?: -(\d+))?:")


def fail(message: str) -> None:
    print(f"::error::{message}" if _in_actions() else message, file=sys.stderr)
    raise SystemExit(1)


def notice(message: str) -> None:
    print(f"::notice::{message}" if _in_actions() else message)


def _in_actions() -> bool:
    import os

    return bool(os.environ.get("GITHUB_ACTIONS"))


def repo_tests(repo: Path) -> list[Path]:
    """Our own copies: fluffychat/tests/*_test.dart."""
    tests_dir = repo / "tests"
    files = sorted(p for p in tests_dir.glob("*_test.dart") if p.is_file())
    return files


def planted_tests(repo: Path) -> dict[str, str]:
    """Tree-relative dart test paths the patches plant, mapped to their patch.

    0016 plants six files (five suites plus `updater_fakes.dart`, a helper with
    no `main`); only `*_test.dart` is collected, because handing a helper to
    `flutter test` fails with "no main()".
    """
    planted: dict[str, str] = {}
    for patch in sorted((repo / "patches").glob("*.patch")):
        text = patch.read_text(encoding="utf-8", errors="replace")
        for path in PATCH_TEST_HEADER.findall(text):
            if path.endswith("_test.dart"):
                planted.setdefault(path, patch.name)
    return planted


def cmd_stage(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    upstream = Path(args.upstream).resolve()
    tree_tests = upstream / "test"
    if not tree_tests.is_dir():
        fail(f"{upstream} has no test/ directory; is this a FluffyChat checkout?")

    ours = repo_tests(repo)
    if not ours:
        fail(f"no dart tests in {repo / 'tests'}; the step would run nothing")

    planted = planted_tests(repo)
    if not planted:
        fail(
            f"no patch in {repo / 'patches'} plants a dart test any more — the parser and "
            "the patch layout have drifted apart, fix the parser before trusting this step"
        )

    # A patch that declares a test it did not plant (the hunk was dropped, the
    # file was renamed) would silently shrink the suite. Catch it before running.
    missing = [path for path in planted if not (upstream / path).is_file()]
    if missing:
        fail(
            "a patch declares these tests but they are not in the tree: "
            + ", ".join(f"{path} ({planted[path]})" for path in sorted(missing))
        )

    # Our repository copies win over the copy a patch planted: the patch text is
    # frozen at the patch's last edit, the repo file is what this commit changed.
    # Running both would count the same test twice.
    staging = upstream / STAGING_DIR
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    our_basenames = set()
    for path in ours:
        shutil.copy2(path, staging / path.name)
        our_basenames.add(path.name)

    to_run = [f"{STAGING_DIR}/{path.name}" for path in ours]
    to_run += [
        path
        for path in sorted(planted)
        if Path(path).name not in our_basenames
    ]

    skipped_planted = sorted(
        path for path in planted if Path(path).name in our_basenames
    )
    for path in skipped_planted:
        print(
            f"skipping {path} ({planted[path]}): our copy under {STAGING_DIR}/ runs instead",
            file=sys.stderr,
        )

    print(f"staged {len(ours)} repository tests and will run {len(to_run)} files", file=sys.stderr)
    print("\n".join(to_run))
    return 0


def cmd_precheck(args: argparse.Namespace) -> int:
    """Refuse a tree `flutter test` cannot run in, with the fix in the message."""
    repo = Path(args.repo).resolve()
    upstream = Path(args.upstream).resolve()

    # pubspec.yaml lists the denoiser model as a package asset, so flutter builds
    # the asset bundle before it runs a single test — and the bundle fails when
    # the file is absent. It is 7.6 MiB of binary, fetched by fetch-model.sh.
    model = repo / "plotina_dfn" / "assets" / "DeepFilterNet3_onnx.tar.gz"
    if not model.is_file() or model.stat().st_size == 0:
        fail(
            f"the denoiser model {model} is missing or empty, and `flutter test` cannot build "
            "the asset bundle without it. Run fluffychat/scripts/fetch-model.sh (the apk job "
            "does this in 'Fetch DeepFilterNet3 model') before the test step."
        )

    if not (upstream / "lib" / "l10n" / "l10n.dart").is_file():
        fail(
            f"{upstream}/lib/l10n/l10n.dart is missing: our tests import package:fluffychat, "
            "which reaches the generated localisations. Run `flutter gen-l10n` in the tree first."
        )
    return 0


def cmd_gate(args: argparse.Namespace) -> int:
    log = Path(args.log)
    if not log.is_file():
        fail(f"{log} does not exist; flutter test produced no log to read")

    text = log.read_text(encoding="utf-8", errors="replace")
    counters = COUNTER.findall(text)
    if not counters:
        fail(
            f"no test counter in {log}: `flutter test` never got as far as running a test "
            "(it usually dies in pub get, gen-l10n or the asset bundle). Last lines:\n"
            + "\n".join(text.strip().splitlines()[-5:])
        )

    # Counters only grow, so the last one is the summary of the whole run.
    passed, skipped, failed = (int(value or 0) for value in counters[-1])
    print(f"flutter test: {passed} passed, {skipped} skipped, {failed} failed")

    if failed:
        fail(f"{failed} test(s) failed in {log}; see the log for the case names")
    if "Some tests failed" in text:
        fail(f"{log} says 'Some tests failed'; see the log for the case names")
    if passed < args.min:
        fail(
            f"only {passed} tests passed, the floor is {args.min}. A green run below the floor "
            "means tests went missing, not that the code got better."
        )

    notice(f"{passed} dart tests passed (floor {args.min}, {skipped} skipped)")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    stage = sub.add_parser("stage", help="copy our tests into the tree, print the run list")
    stage.add_argument("--repo", required=True, help="the fluffychat/ directory of this repo")
    stage.add_argument("--upstream", required=True, help="the patched upstream checkout")
    stage.set_defaults(func=cmd_stage)

    precheck = sub.add_parser("precheck", help="refuse a tree flutter test cannot run in")
    precheck.add_argument("--repo", required=True)
    precheck.add_argument("--upstream", required=True)
    precheck.set_defaults(func=cmd_precheck)

    gate = sub.add_parser("gate", help="fail unless the run passed enough tests")
    gate.add_argument("--log", required=True, help="captured `flutter test` output")
    gate.add_argument("--min", type=int, default=60, help="minimum passing tests (default 60)")
    gate.set_defaults(func=cmd_gate)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
