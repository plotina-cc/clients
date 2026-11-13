#!/usr/bin/env python3
"""The image build context must be complete before docker is asked to build it.

CI stages the context from two trees — ``element-web/.`` at the root and the
shared ``noise/`` overlay as ``./noise`` (``.github/workflows/build-element-web.yml``,
"Assemble the build context"; ``scripts/build-image.sh`` does the same pair) —
and then the Dockerfile COPYs single files out of it and asserts the result
inside the image.  A source that leaves one of those trees does not fail a unit
test, does not fail review and does not fail the workflow's early steps: it
fails *inside* ``docker build``, after the layer cache is warm, with

    ERROR: failed to build: failed to solve: failed to compute cache key:
    failed to calculate checksum of ref …: "/noise/plotina-panel.js": not found

That is exactly how Element Call .17 broke the Web image on 2026-11-13: the
floating noise capsule went away together with ``noise/plotina-panel.js`` and
``element-web/Dockerfile`` still COPYied it.

Three rules, all readable in a second because they only read files:

  COPY      every ``COPY src … dst`` source resolves inside the context
  ASSERT    ``test -s /app/X`` is backed by a COPY of X; ``! test -e /app/X`` is
            not (the layer says the file must be absent, a COPY would undo it)
  WIDGET    every ``../../noise/<file>`` the call-widget checker *requires* is a
            file the noise/ overlay actually carries

usage: check-build-context.py [--dockerfile PATH] [--web-dir DIR] [--repo-root DIR]
exit 0 when every rule holds, 1 with one line per problem otherwise.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

DEFAULT_WEB_DIR = Path(__file__).resolve().parent.parent
# The two trees the context is assembled from, relative to the repository root.
CONTEXT_TREES = ("element-web", "noise")


def copy_sources(text: str) -> list[str]:
    """Source paths of every plain ``COPY src [src …] dst`` instruction.

    Only what this Dockerfile uses: no flags, no ``--from`` stages, no URLs.  An
    unknown shape is an error rather than a silent skip — a COPY this checker
    does not model is a COPY nobody checks.
    """
    sources: list[str] = []
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped.startswith("COPY "):
            continue
        parts = stripped.split()[1:]
        if not parts or parts[0].startswith("--"):
            raise ValueError(f"Dockerfile line {number}: unsupported COPY shape: {stripped}")
        sources.extend(parts[:-1])
    return sources


def resolve(source: str, web_dir: Path, repo_root: Path) -> Path | None:
    """Where a COPY source lives in the staged context, or None.

    CI copies ``element-web/.`` to the context root and ``noise/`` to
    ``./noise``, so a source resolves either under the web directory or under
    the repository root (``noise/logic.js`` -> ``<repo>/noise/logic.js``).
    """
    for tree in (web_dir, repo_root):
        candidate = tree / source
        if candidate.exists():
            return candidate
    return None


def missing_sources(text: str, web_dir: Path, repo_root: Path) -> list[str]:
    """COPY sources docker would fail to find (``failed to calculate checksum``)."""
    missing = []
    for source in copy_sources(text):
        if resolve(source, web_dir, repo_root) is None:
            missing.append(source)
    return missing


def destination_paths(text: str) -> set[str]:
    """Absolute paths the Dockerfile writes with COPY (``dst`` of each COPY)."""
    destinations: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("COPY "):
            continue
        parts = stripped.split()[1:]
        if parts and not parts[0].startswith("--"):
            destinations.add(parts[-1])
    return destinations


def assertion_problems(text: str) -> list[str]:
    """Files the image layer promises to have (or not to have) but COPY disagrees.

    ``test -s /app/X`` on something nothing COPYied can only fail at build time;
    ``! test -e /app/X`` next to a ``COPY … /app/X`` is a contradiction the build
    resolves by copying the file the layer just swore is absent.  Only ``/app``
    paths are considered: a build-time file under ``/tmp`` is copied on purpose
    and deleted in the same layer.
    """
    copied = destination_paths(text)
    problems: list[str] = []

    def covered(path: str) -> bool:
        return any(path == dest or path.startswith(dest.rstrip("/") + "/") for dest in copied)

    for line in text.splitlines():
        for path in re.findall(r"(?<!! )\btest -s (\S+)", line):
            path = path.rstrip(";")
            if path.startswith("/app/") and not covered(path):
                problems.append(f"the layer asserts {path} exists but no COPY writes it")
        for path in re.findall(r"!\s*test -e (\S+)", line):
            path = path.rstrip(";")
            if path.startswith("/app/") and covered(path):
                problems.append(f"the layer asserts {path} is absent but a COPY writes it")
    return problems


def widget_noise_problems(core: Path, repo_root: Path) -> list[str]:
    """Files the call-widget checker requires from ``../../noise/`` but noise/ lacks."""
    if not core.is_file():
        return [f"{core} is missing"]
    text = core.read_text(encoding="utf-8")
    noise = repo_root / "noise"
    problems: list[str] = []
    # Only the relative tags: those are the files the widget's index loads at
    # ../../noise/, so they have to be in the image.  The absolute /noise/… tags
    # are strip patterns for the edge archive and need not exist.
    for name in sorted(set(re.findall(r'src="\.\./\.\./noise/([^"]+)"', text))):
        if not (noise / name).is_file():
            problems.append(
                f"the widget checker requires ../../noise/{name}, which noise/ does not carry"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=("The image build context must be "
                                                  "complete before docker builds it."))
    parser.add_argument("--dockerfile", type=Path, help="default: <web-dir>/Dockerfile")
    parser.add_argument("--web-dir", type=Path, default=DEFAULT_WEB_DIR)
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_WEB_DIR.parent)
    parser.add_argument("--widget-core", type=Path,
                        help="default: <web-dir>/scripts/element-call-widget-core.py")
    args = parser.parse_args(argv)

    web_dir = args.web_dir.resolve()
    repo_root = args.repo_root.resolve()
    dockerfile = (args.dockerfile or web_dir / "Dockerfile").resolve()
    core = (args.widget_core or web_dir / "scripts" / "element-call-widget-core.py").resolve()

    text = dockerfile.read_text(encoding="utf-8")
    problems = [f"COPY source not in the build context: {src}" for src in
                missing_sources(text, web_dir, repo_root)]
    problems += assertion_problems(text)
    problems += widget_noise_problems(core, repo_root)

    if problems:
        for problem in problems:
            print(f"build context: {problem}", file=sys.stderr)
        return 1
    print(f"build context ok: {dockerfile.name} resolves inside "
          f"{', '.join(CONTEXT_TREES)} ({len(copy_sources(text))} COPY sources)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
