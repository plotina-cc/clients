"""Tests for element-desktop/scripts/guard-dev-base.sh — the early gate that
refuses a Desktop dev tag (`-dev.M`) unless its base already has a *published
release with updater metadata*.

Why this exists: on `v1.12.32-plotina-desktop.49` the tag existed for hours
before any release did. A guard that only asks "does the tag exist" passes that
case, so this gate asks the releases API (a tag is not a release) and then asks
for `latest-linux.yml` / `latest.yml` in the assets (a release without them
cannot update anyone).

The gate decides whether a whole build runs, so it is driven here against a stub
`gh` that models the real CLI: the release fixture goes to stdout, a missing
release exits 1 with GitHub's "Not Found (HTTP 404)". No network and no token.
The stub also records every query, which is how "stable tags are not checked at
all" is proven — a gate that queried and shrugged would satisfy a laxer
assertion.
"""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "element-desktop" / "scripts" / "guard-dev-base.sh"

# `gh api repos/<repo>/releases/tags/<tag> --jq '.assets[].name'` is the only
# invocation the gate is allowed to make: anything else is a stub error, so a
# rewritten script cannot silently keep passing through a stale stub.
STUB_GH = r"""#!/usr/bin/env bash
set -u
path="${2:-}"
printf 'api %s\n' "$path" >> "$STUB_LOG"
if [ "${1:-}" != "api" ]; then
  echo "stub gh: unsupported invocation: $*" >&2
  exit 64
fi
if [ "${3:-}" != "--jq" ] || [ "${4:-}" != ".assets[].name" ]; then
  echo "stub gh: unexpected arguments: $*" >&2
  exit 64
fi
case "$path" in
  repos/*/releases/tags/*) tag="${path##*/}" ;;
  *) echo "stub gh: unsupported path: $path" >&2; exit 64 ;;
esac
fixture="$STUB_RELEASES/$tag.json"
if [ ! -f "$fixture" ]; then
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$fixture" \
  | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
"""

LINUX = "latest-linux.yml"
WINDOWS = "latest.yml"


class GuardDevBaseTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.bin = root / "bin"
        self.bin.mkdir()
        self.releases = root / "releases"
        self.releases.mkdir()
        self.log = root / "gh-calls.log"
        gh = self.bin / "gh"
        gh.write_text(STUB_GH, encoding="utf-8")
        gh.chmod(gh.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

    # --- fixtures ---------------------------------------------------------
    def publish(self, tag: str, assets: list[str]) -> None:
        """A published release: the API knows the tag and lists these assets."""
        payload = {"tag_name": tag, "assets": [{"name": a} for a in assets]}
        (self.releases / f"{tag}.json").write_text(json.dumps(payload), encoding="utf-8")

    def run_guard(self, tag: str | None = None, ref_name: str | None = None, repo: str | None = None):
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in {"GH_TOKEN", "GITHUB_TOKEN", "GITHUB_REF_NAME", "GITHUB_REPOSITORY", "GITHUB_REF"}
        }
        env["PATH"] = f"{self.bin}{os.pathsep}{env.get('PATH', '')}"
        env["STUB_RELEASES"] = str(self.releases)
        env["STUB_LOG"] = str(self.log)
        if ref_name is not None:
            env["GITHUB_REF_NAME"] = ref_name
        if repo is not None:
            env["GITHUB_REPOSITORY"] = repo
        argv = ["bash", str(SCRIPT)] + ([tag] if tag is not None else [])
        proc = subprocess.run(argv, env=env, capture_output=True, text=True)
        return proc.returncode, proc.stdout, proc.stderr

    def gh_calls(self) -> list[str]:
        if not self.log.exists():
            return []
        return [line for line in self.log.read_text(encoding="utf-8").splitlines() if line.strip()]

    # --- the case that started this card ---------------------------------
    def test_dev_tag_on_published_base_passes(self) -> None:
        """Tag exists AND the base release is published with both metadata files."""
        self.publish("v1.12.32-plotina-desktop.49", [LINUX, WINDOWS])
        rc, out, err = self.run_guard("v1.12.32-plotina-desktop.49-dev.4")
        self.assertEqual(rc, 0, f"expected the dev tag to be allowed\nstdout:\n{out}\nstderr:\n{err}")
        # The gate must ask about the BASE release, not the dev tag itself.
        self.assertEqual(self.gh_calls(), ["api repos/plotina-cc/clients/releases/tags/v1.12.32-plotina-desktop.49"])
        self.assertIn("v1.12.32-plotina-desktop.49", out)
        self.assertIn("разрешён", out)

    def test_dev_tag_on_unpublished_base_is_rejected(self) -> None:
        """`.49` as it was at 20:00: the tag existed, the release did not."""
        self.publish("v1.12.32-plotina-desktop.45", [LINUX, WINDOWS])
        rc, out, err = self.run_guard("v1.12.32-plotina-desktop.49-dev.1")
        self.assertNotEqual(rc, 0, f"a dev tag on an unpublished base must fail\nstdout:\n{out}\nstderr:\n{err}")
        self.assertIn("v1.12.32-plotina-desktop.49", err)
        self.assertIn("не опубликована", err)
        self.assertIn("dev-теги на ней запрещены", err)
        self.assertEqual(self.gh_calls(), ["api repos/plotina-cc/clients/releases/tags/v1.12.32-plotina-desktop.49"])

    # --- "published" means the assets are there ---------------------------
    def test_release_without_windows_metadata_is_rejected(self) -> None:
        self.publish("v1.12.32-plotina-desktop.49", [LINUX])
        rc, _out, err = self.run_guard("v1.12.32-plotina-desktop.49-dev.4")
        self.assertNotEqual(rc, 0, "a release without latest.yml is not a published base")
        self.assertIn(WINDOWS, err)
        self.assertIn("не опубликована", err)

    def test_release_without_linux_metadata_is_rejected(self) -> None:
        self.publish("v1.12.32-plotina-desktop.49", [WINDOWS])
        rc, _out, err = self.run_guard("v1.12.32-plotina-desktop.49-dev.4")
        self.assertNotEqual(rc, 0, "a release without latest-linux.yml is not a published base")
        self.assertIn(LINUX, err)
        self.assertIn("не опубликована", err)

    # --- stable tags and non-tag refs are out of scope --------------------
    def test_stable_tag_is_not_checked(self) -> None:
        """The first release of a base has no published base — it must not be gated."""
        rc, out, err = self.run_guard("v1.12.32-plotina-desktop.50")
        self.assertEqual(rc, 0, f"a stable tag must never be gated\nstdout:\n{out}\nstderr:\n{err}")
        self.assertEqual(self.gh_calls(), [], "a stable tag must not even query the releases API")

    def test_branch_ref_is_not_checked(self) -> None:
        rc, out, _err = self.run_guard("some-branch-without-dev")
        self.assertEqual(rc, 0)
        self.assertEqual(self.gh_calls(), [])
        self.assertIn("не dev-тег", out)

    def test_workflow_dispatch_ref_name_is_not_checked(self) -> None:
        """`workflow_dispatch` on a branch: ref_name is a branch, not a tag."""
        rc, _out, _err = self.run_guard(None, ref_name="main")
        self.assertEqual(rc, 0)
        self.assertEqual(self.gh_calls(), [])

    def test_tag_taken_from_github_ref_name(self) -> None:
        self.publish("v1.12.32-plotina-desktop.49", [LINUX, WINDOWS])
        rc, _out, err = self.run_guard(None, ref_name="v1.12.32-plotina-desktop.49-dev.4")
        self.assertEqual(rc, 0, f"GITHUB_REF_NAME must carry the tag when no argument is given\nstderr:\n{err}")
        self.assertEqual(self.gh_calls(), ["api repos/plotina-cc/clients/releases/tags/v1.12.32-plotina-desktop.49"])

    # --- fail closed ------------------------------------------------------
    def test_unparseable_dev_tag_fails_closed(self) -> None:
        """A dev tag we cannot map to a base tag must not fall through as green."""
        rc, _out, err = self.run_guard("v1.12.32-plotina-desktop-dev.4")
        self.assertNotEqual(rc, 0)
        self.assertIn("не удалось разобрать", err)
        self.assertEqual(self.gh_calls(), [], "nothing to ask when the tag does not parse")

    def test_repository_override(self) -> None:
        self.publish("v1.12.32-plotina-desktop.49", [LINUX, WINDOWS])
        rc, _out, _err = self.run_guard("v1.12.32-plotina-desktop.49-dev.4", repo="someone/fork")
        self.assertEqual(rc, 0)
        self.assertEqual(self.gh_calls(), ["api repos/someone/fork/releases/tags/v1.12.32-plotina-desktop.49"])


class WorkflowWiringTest(unittest.TestCase):
    """The gate only helps if it actually runs before the build.

    Checked as text on purpose: this suite must run on a bare runner where PyYAML
    is not installed, and the assertions are about job wiring (which job exists,
    which job needs it), not about YAML semantics — preflight.sh parses the file.
    """

    WORKFLOW = REPO_ROOT / ".github" / "workflows" / "build-element-desktop.yml"

    def setUp(self) -> None:
        self.text = self.WORKFLOW.read_text(encoding="utf-8")
        self.lines = self.text.splitlines()

    def job_index(self, job: str) -> int:
        for i, line in enumerate(self.lines):
            if line == f"  {job}:":
                return i
        self.fail(f"job '{job}' not found in {self.WORKFLOW.name}")

    def test_guard_job_is_declared_before_webapp(self) -> None:
        self.assertLess(
            self.job_index("dev-base-guard"),
            self.job_index("webapp"),
            "the dev-base guard must be declared before the heavy webapp job",
        )

    def test_guard_job_runs_the_script_with_the_tag(self) -> None:
        start = self.job_index("dev-base-guard")
        end = self.job_index("webapp")
        body = "\n".join(self.lines[start:end])
        self.assertIn("element-desktop/scripts/guard-dev-base.sh", body)
        self.assertIn('TAG: ${{ github.ref_name }}', body)
        self.assertIn("test_guard_dev_base.py", body, "the guard job must run this suite itself")

    def test_webapp_waits_for_the_guard_and_build_waits_for_webapp(self) -> None:
        """One needs-edge is enough to gate every heavy job: build -> webapp -> guard."""
        self.assertIn("    needs: [dev-base-guard]", self.text, "webapp must depend on the guard")
        self.assertIn("    needs: [webapp]", self.text, "build must still depend on webapp")

    def test_guard_does_not_depend_on_anything(self) -> None:
        start = self.job_index("dev-base-guard")
        end = self.job_index("webapp")
        body = "\n".join(self.lines[start:end])
        self.assertNotIn("needs:", body, "the guard must be the first thing that runs")


if __name__ == "__main__":
    unittest.main()

