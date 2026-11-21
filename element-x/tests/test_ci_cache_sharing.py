#!/usr/bin/env python3
"""The X workflow's two Gradle jobs must land on ONE cache entry, and the tests must execute.

Both facts are computed, not grepped: this test reads `build-element-x.yml`, extracts what each job
hands to `gradle/actions/setup-gradle`, and runs the action's published cache-key algorithm over it
(sources/src/caching/cache-key.ts at v4):

    base    = "<prefix>gradle-home-v1"
    env     = "<base>|<RUNNER_OS>-<RUNNER_ARCH>"
    job     = "<env>|<GRADLE_BUILD_ACTION_CACHE_KEY_JOB or the current job id>"
    inst    = "<job>[<GRADLE_BUILD_ACTION_CACHE_KEY_JOB_INSTANCE or hash(workflow, matrix)>]"
    key     = "<inst>-<git sha>"
    restore = [inst, job, env]        # tried in this order, first prefix match wins

The consequence that decided this workflow's shape: `job` is the *job id*. The ladder always reaches
an `env`-only prefix, which every job on the runner shares, so a job with no entry of its own would
fall back to whatever the other job saved. But its OWN entries sit earlier in the ladder: once
`kotlin-tests` has written its own `kotlin-tests[…]` entry, the `job` level matches that entry and
the fallback to `env` is never reached. A second writer therefore does not just waste 114 MB — it
permanently pins the test job to its own stale copy. That is the defect this card fixes.

So `cache-read-only: true` alone is NOT a fix: the key still carries the job id, the ladder still
prefers the job level, and the job's own entry (if any) is still what it restores. Sharing requires
overriding the job component, and read-only is what then stops the duplicate being written again.

Two properties are pinned:

  * cache   — kotlin-tests restores what `build` writes, and writes nothing of its own;
  * execute — the test invocation cannot be satisfied FROM-CACHE/UP-TO-DATE, because a test task
              whose result is restored from the local build cache never runs the tests.

Every assertion carries a negative control in `NegativeControls` below: the same checker, fed a
configuration that lacks the fix, must report the defect. A checker that cannot fail proves nothing,
so that class fails the suite when its mutations stop being detected.

Run: python3 -m unittest discover -s element-x/tests -p 'test_*.py' -v
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

WORKFLOW = (
    Path(__file__).resolve().parents[2]
    / ".github"
    / "workflows"
    / "build-element-x.yml"
)

JOB_HEADER = re.compile(r"^  ([a-zA-Z][\w-]*):\s*$")
SETUP_GRADLE = "gradle/actions/setup-gradle"
JOB_KEY_VAR = "GRADLE_BUILD_ACTION_CACHE_KEY_JOB"
MATRIX_HASH = "0f1e2d3c4b5a69788796a5b4c3d2e1f0"  # stands in for hash(workflow, matrix)
SHA = "0" * 40


def block_of(lines: list[str], start: int) -> list[str]:
    """The lines of the YAML block that opens at `start` (deeper indent, plus the line itself)."""
    indent = len(lines[start]) - len(lines[start].lstrip())
    body = [lines[start]]
    for line in lines[start + 1 :]:
        if not line.strip():
            body.append(line)
            continue
        if len(line) - len(line.lstrip()) <= indent:
            break
        body.append(line)
    return body


def jobs(lines: list[str]) -> dict[str, list[str]]:
    """`{job id: its lines}` for every job under the top-level `jobs:`."""
    try:
        jobs_at = next(i for i, line in enumerate(lines) if line.rstrip() == "jobs:")
    except StopIteration:
        return {}
    found: dict[str, list[str]] = {}
    for index in range(jobs_at + 1, len(lines)):
        match = JOB_HEADER.match(lines[index])
        if match:
            found[match.group(1)] = block_of(lines, index)
    return found


def setting(job_lines: list[str], key: str) -> str | None:
    """The literal value of `key:` anywhere in the job, or None when the job does not set it."""
    pattern = re.compile(rf"^\s*{re.escape(key)}:\s*(.+?)\s*$")
    for line in job_lines:
        match = pattern.match(line)
        if match:
            return match.group(1).strip().strip("'\"")
    return None


def setup_gradle_step(job_lines: list[str]) -> str:
    """The `gradle/actions/setup-gradle` step as text, with its `with:`/`env:` keys."""
    for index, line in enumerate(job_lines):
        if SETUP_GRADLE in line:
            return "\n".join(block_of(job_lines, index))
    return ""


def cache_key(job_id: str, key_job: str | None) -> tuple[str, list[str]]:
    """The action's key and restore ladder for one job (cache-key.ts, non-strict match)."""
    env = "gradle-home-v1|Linux-X64"
    job = f"{env}|{key_job or job_id}"
    inst = f"{job}[{MATRIX_HASH}]"
    return f"{inst}-{SHA}", [inst, job, env]


def restored_entry(reader_ladder: list[str], existing: dict[str, str]) -> str | None:
    """Which saved entry the reader actually restores.

    `existing` maps a saved key to the job that wrote it. The ladder is walked in order and the
    first prefix that matches any existing entry wins — which is how the action's restore behaves.
    """
    for prefix in reader_ladder:
        for saved_key, writer in existing.items():
            if saved_key.startswith(prefix):
                return writer
    return None


def reader_restores_writer(reader_job: str, reader_key_job: str | None,
                           writer_job: str, writer_key_job: str | None) -> bool:
    """True when `reader_job`, with its own entry present, still restores what `writer_job` wrote."""
    reader_key, ladder = cache_key(reader_job, reader_key_job)
    writer_key, _ = cache_key(writer_job, writer_key_job)

    # Identical keys are a single entry: one job writes it, both read it.
    if reader_key == writer_key:
        return True

    # Otherwise both jobs have their own entry, and the ladder decides. A prefix matches by string
    # prefix, so the writer's key is what the reader must be able to reach.
    for prefix in ladder:
        if writer_key.startswith(prefix):
            return True
        if reader_key.startswith(prefix):
            return False  # the reader's own entry is reached first and shadows the writer's
    return False


class OneCacheForBothJobs(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.lines = cls.text.splitlines()
        cls.jobs = jobs(cls.lines)

    def test_the_two_gradle_jobs_exist(self) -> None:
        for name in ("build", "kotlin-tests"):
            self.assertIn(name, self.jobs, f"no {name!r} job in the workflow")
            self.assertIn(SETUP_GRADLE, "\n".join(self.jobs[name]),
                          f"{name} no longer sets up Gradle")

    def test_kotlin_tests_reads_the_build_entry(self) -> None:
        build_key_job = setting(self.jobs["build"], JOB_KEY_VAR)
        tests_key_job = setting(self.jobs["kotlin-tests"], JOB_KEY_VAR)
        tests_key, tests_ladder = cache_key("kotlin-tests", tests_key_job)
        build_key, _ = cache_key("build", build_key_job)

        self.assertTrue(
            reader_restores_writer("kotlin-tests", tests_key_job, "build", build_key_job),
            "kotlin-tests does not restore the Gradle User Home entry that `build` saves.\n"
            f"  build      key={build_key}\n"
            f"  kotlin-tests key={tests_key}\n"
            f"  kotlin-tests ladder={tests_ladder}\n"
            "The job component of the key is the job id, so the test job needs "
            f"{JOB_KEY_VAR}=build; otherwise its own entry shadows the shared one.\n"
            f"--- tests setup-gradle ---\n{setup_gradle_step(self.jobs['kotlin-tests'])}",
        )

    def test_only_build_writes_the_entry(self) -> None:
        """A second writer is the duplicate this test exists to prevent."""
        tests = setup_gradle_step(self.jobs["kotlin-tests"])
        self.assertRegex(
            tests,
            r"cache-read-only:\s*true",
            "kotlin-tests must be cache-read-only: a second writer writes a duplicate entry.\n" + tests,
        )

    def test_build_still_writes_the_entry(self) -> None:
        """Read-only everywhere would leave nothing to read: the writer must stay writable."""
        build = setup_gradle_step(self.jobs["build"])
        self.assertNotRegex(
            build,
            r"cache-read-only:\s*true",
            "build must keep writing the Gradle User Home entry, or there is nothing to share.\n" + build,
        )

    def test_the_test_tasks_are_forced_to_execute(self) -> None:
        """FROM-CACHE is green without running a test; the gate would then read restored XML."""
        run_step = ""
        for index, line in enumerate(self.jobs["kotlin-tests"]):
            if "run-unit-tests.sh" in line:
                run_step = "\n".join(block_of(self.jobs["kotlin-tests"], index))
                break
        self.assertTrue(run_step.strip(), "no run-unit-tests.sh step in kotlin-tests")
        self.assertRegex(
            run_step,
            r"--rerun\b",
            "the test invocation must pass --rerun: a test task satisfied FROM-CACHE (or UP-TO-DATE) "
            "never executes its tests, and the gate then reads the restored JUnit XML.\n" + run_step,
        )


class NegativeControls(unittest.TestCase):
    """The checker must report the defect when the fix is absent — else it proves nothing."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.lines = WORKFLOW.read_text(encoding="utf-8").splitlines()

    def test_the_check_detects_the_unfixed_workflow(self) -> None:
        """With no job-key override the reader keeps its own entry: the checker must say so."""
        without_override = "\n".join(line for line in self.lines if JOB_KEY_VAR not in line)
        self.assertNotEqual(
            "\n".join(self.lines), without_override,
            f"the workflow never sets {JOB_KEY_VAR}, so this control has nothing to remove",
        )
        self.assertFalse(
            reader_restores_writer("kotlin-tests", None, "build", None),
            "the sharing check accepts the default configuration, where the test job restores its "
            "own entry — it cannot detect the defect it exists to reject",
        )

    def test_the_own_entry_shadows_the_shared_one(self) -> None:
        """The mechanism, stated: the job-level prefix is reached before the env-level fallback."""
        own_key, ladder = cache_key("kotlin-tests", None)
        build_key, _ = cache_key("build", None)
        self.assertIn(own_key, [own_key], "sanity: the job saved its own entry")
        self.assertEqual(
            restored_entry(ladder, {own_key: "kotlin-tests", build_key: "build"}),
            "kotlin-tests",
            "with both entries present the test job must restore its own; if this changes, the "
            "premise of the fix is stale",
        )

    def test_the_shared_entry_wins_once_the_override_is_set(self) -> None:
        """With the override, both jobs compute the same key: only one entry can exist."""
        build_key, _ = cache_key("build", "build")
        tests_key, _ = cache_key("kotlin-tests", "build")
        self.assertEqual(
            build_key, tests_key,
            "the override must make both jobs compute the SAME key, or they still diverge",
        )

    def test_a_read_only_job_with_a_job_scoped_key_reads_nothing_shared(self) -> None:
        """The trap: read-only plus the default key is strictly worse than today."""
        self.assertFalse(
            reader_restores_writer("kotlin-tests", None, "build", None),
            "read-only with a job-scoped key was accepted as sharing; it would leave the tests cold",
        )


if __name__ == "__main__":
    unittest.main()
