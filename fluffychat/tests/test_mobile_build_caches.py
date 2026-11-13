#!/usr/bin/env python3
"""The Mobile build's caches must be written where a tag can read them.

GitHub scopes every cache entry to the ref that saved it, and only entries
written on the default branch are readable from every other ref — including
tags ("Branch scope: cache entries written for a Git branch are not visible
from actions running against different branches or tags. Entries written for
the default branch are visible to all", gradle/actions docs, setup-gradle.md).

Mobile saved its rust and pub caches from tag runs only, so every release paid
for a cold cargo registry and a cold pub cache: the `.35` run printed "No cache
found" while caches with the *same key* existed under `refs/tags/…` of earlier
tags, and `Build native denoiser` took 8 minutes of the job's 25.8.

This test pins the contract that fixes it, in the workflow itself, because
every one of these lines is a silent failure when it goes away:

  * the workflow runs on `main`, the only ref whose cache writes a tag reads;
  * a main run is gated on the paths that actually invalidate a cache (rust
    crate, upstream pin, this file), so main does not rebuild an APK for a
    patch that cannot change a cache;
  * `Swatinem/rust-cache` saves only on `refs/heads/main` — a tag that saved
    its own copy is exactly the 634 MB-per-release leak this replaced;
  * `gradle/actions/setup-gradle` is present before the APK build, so the
    Gradle User Home is written on main and restored on tags;
  * `subosito/flutter-action` keeps `cache: true`, which is what caches pub
    at all (`flutter-pub-…` entries) — with `pub-cache: false` there would be
    no pub cache to restore.

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

STEP_START = re.compile(r"^(\s*)- (?:uses|name):")


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


def short(text: str, limit: int = 700) -> str:
    """An assertion message must stay readable: a job block is thousands of chars."""
    text = text.strip()
    return text if len(text) <= limit else text[:limit] + f"\n… ({len(text)} chars)"


def find_blocks(lines: list[str], pattern: re.Pattern[str], opener: re.Pattern[str]) -> list[list[str]]:
    """Every block whose first line matches `pattern`, opened by `opener`."""
    found = []
    for index, line in enumerate(lines):
        if pattern.search(line):
            found.append(block_of(lines, index))
    return found


def steps(lines: list[str]) -> list[list[str]]:
    return find_blocks(lines, STEP_START, STEP_START)


def job(lines: list[str], name: str) -> list[str]:
    """The lines of `  <name>:` under `jobs:`."""
    header = re.compile(rf"^  {re.escape(name)}:\s*$")
    for index, line in enumerate(lines):
        if header.match(line):
            return block_of(lines, index)
    return []


class WorkflowFile(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.lines = cls.text.splitlines()
        cls.steps = steps(cls.lines)

    def named_step(self, marker: str) -> list[str]:
        for step in self.steps:
            if marker in step[0] or any(marker in line for line in step):
                return step
        self.fail(f"no step mentions {marker!r}")
        return []  # unreachable, keeps type checkers quiet


class MainRunsTheBuild(WorkflowFile):
    """A cache written on a tag is invisible to the next tag; main's is not."""

    def test_workflow_triggers_on_main(self) -> None:
        on_block = block_of(self.lines, next(
            index for index, line in enumerate(self.lines) if line.startswith("on:")
        ))
        push = block_of(on_block, next(
            index for index, line in enumerate(on_block) if re.match(r"^\s+push:\s*$", line)
        ))
        joined = "\n".join(push)
        self.assertIn("main", joined, "push trigger does not name the default branch:\n" + short(joined))
        self.assertIn("v*-plotina-mobile.*", joined, "the tag trigger must stay:\n" + short(joined))

    def test_main_build_is_gated_on_cache_inputs(self) -> None:
        apk = "\n".join(job(self.lines, "apk"))
        self.assertIn("needs: [cache-inputs]", apk,
                      "the apk job must depend on the cache-inputs gate")
        self.assertIn("needs.cache-inputs.outputs.build", apk,
                      "the apk job must skip a main run that cannot change a cache")

    def test_gate_recognises_every_cache_input(self) -> None:
        gate = "\n".join(job(self.lines, "cache-inputs"))
        self.assertTrue(gate.strip(), "no cache-inputs job")
        pattern = re.search(r"grep -qE '([^']+)'", gate)
        self.assertIsNotNone(pattern, "the gate has no path pattern:\n" + short(gate))
        regex = re.compile(pattern.group(1))  # type: ignore[union-attr]

        # These invalidate a cache, so a main run must happen.
        for changed in (
            "fluffychat/plotina_dfn/rust/Cargo.lock",
            "fluffychat/plotina_dfn/rust/src/lib.rs",
            "fluffychat/UPSTREAM_TAG",
            ".github/workflows/build-fluffychat.yml",
        ):
            self.assertTrue(regex.search(changed),
                            f"{changed} is a cache input but does not trigger a build")

        # These do not: a patch or a client source file leaves the caches valid.
        for unrelated in (
            "fluffychat/patches/0025-notification-cancel.patch",
            "fluffychat/lib/main.dart",
            ".github/workflows/build-element-x.yml",
            "README.md",
        ):
            self.assertFalse(regex.search(unrelated),
                             f"{unrelated} must not cost a main build")


class CacheWritesAreScopedToMain(WorkflowFile):
    def test_rust_cache_saves_only_on_main(self) -> None:
        step = "\n".join(self.named_step("Swatinem/rust-cache@v2"))
        self.assertIn("github.ref == 'refs/heads/main'", step,
                      "rust-cache must not save under a tag scope:\n" + short(step))
        self.assertIn("save-if:", step, "rust-cache has no save-if:\n" + short(step))
        self.assertIn("workspaces:", step, "rust-cache lost its workspace:\n" + short(step))

    def test_gradle_cache_is_set_up_before_the_apk(self) -> None:
        order = [i for i, step in enumerate(self.steps)
                 if "gradle/actions/setup-gradle" in "\n".join(step)]
        self.assertEqual(len(order), 1, "expected exactly one setup-gradle step")
        build = [i for i, step in enumerate(self.steps)
                 if "Build APK" in step[0]]
        self.assertTrue(build, "no Build APK step")
        self.assertLess(order[0], build[0],
                        "setup-gradle must run before the Gradle build it caches")
        gradle_step = "\n".join(self.steps[order[0]])
        self.assertNotIn("cache-read-only: true", gradle_step,
                         "a read-only Gradle cache can never be primed:\n" + short(gradle_step))

    def test_flutter_action_still_caches_pub(self) -> None:
        step = "\n".join(self.named_step("subosito/flutter-action"))
        self.assertRegex(step, r"cache:\s*true",
                         "flutter-action no longer caches pub:\n" + short(step))
        self.assertNotRegex(step, r"pub-cache:\s*false",
                            "pub caching was switched off:\n" + short(step))


class DevAndStableShareOneRustCache(WorkflowFile):
    """The cache a release restores has to be the one main wrote.

    A dev tag compiles arm64 only, a stable tag and a main push compile three
    ABIs, and the matrix exports that difference as `CARGO_NDK_TARGETS`,
    `CARGO_NDK_FLAGS` and `RUST_TARGETS`. `Swatinem/rust-cache` hashes every
    variable whose name starts with `CARGO`, `CC`, `CFLAGS`, `CXX`, `CMAKE` or
    `RUST` into the key, so those three put dev and main in two different
    scopes: the .35-dev.6 run printed `save-if: false` and `No cache found`
    while a 634 MB cache from main sat in the repository. The cache holds the
    cargo registry and the `target` directory, both partitioned per target
    triple by cargo itself, so the ABI set does not invalidate it — the
    rust-cache step must not see those variables.
    """

    ABI_VARS = ("CARGO_NDK_TARGETS", "CARGO_NDK_FLAGS", "RUST_TARGETS")

    def matrix_step(self) -> str:
        return "\n".join(self.named_step("Work out the ABI set"))

    def test_the_matrix_exports_the_abi_set_to_every_step(self) -> None:
        matrix = self.matrix_step()
        self.assertIn("GITHUB_ENV", matrix,
                      "the matrix no longer exports the ABI set; this test would be "
                      "vacuous:\n" + short(matrix))
        self.assertIn("abi-matrix.py", matrix,
                      "the ABI set no longer comes from abi-matrix.py:\n" + short(matrix))
        # The variables are real: a later step reads one from the environment
        # the matrix step just wrote into.
        denoiser = "\n".join(self.named_step("Build native denoiser"))
        self.assertIn("$CARGO_NDK_TARGETS", denoiser,
                      "no step reads the exported ABI list:\n" + short(denoiser))

    def test_abi_set_does_not_reach_the_rust_cache_key(self) -> None:
        step = "\n".join(self.named_step("Swatinem/rust-cache@v2"))
        for variable in self.ABI_VARS:
            # `env:` on the step, with an empty value — rust-cache skips empty
            # variables when it builds the key hash.
            self.assertRegex(
                step,
                rf"{variable}:\s*(\"\"|'')",
                f"{variable} reaches the rust-cache key, so a dev tag can never "
                f"restore what main saved:\n" + short(step),
            )


if __name__ == "__main__":
    unittest.main()
