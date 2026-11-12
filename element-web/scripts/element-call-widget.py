#!/usr/bin/env python3
"""Install or verify Plotina's Element Call in the Element Web image.

    element-call-widget.py --lock element-call.lock.json --work /tmp/ec --webapp /app
    element-call-widget.py --check --webapp /app

The image is the pinned upstream one plus an overlay, and the upstream image
ships a stock Element Call under /app/widgets/element-call/: none of our patches
(element-call/patches/), so the browser client has neither per-person volume
memory (0004) nor the hide-this-stream control (0005). This replaces that widget
wholesale with the archive .github/workflows/build-element-call.yml publishes,
pinned in element-desktop/element-call.lock.json by tag + sha256 — one pin for
both clients, never "latest".

This file is an adapter, not a second implementation: the swap and every check
live in the desktop module (element-desktop/scripts/element-call-widget.py,
`--webapp` / `--check` / `--url-prefix` / `--lock`). The only thing that differs
between the clients is where the widget is served from:

  * Desktop serves the webapp from vector://vector/webapp/, so the widget is
    opened at /webapp/widgets/element-call/;
  * Element Web serves the app from the site root and its bundle opens
    ./widgets/element-call/ (bundles/<hash>/6312.js), so the widget is opened at
    /widgets/element-call/ and every root-absolute asset URL has to be rebased
    onto that path instead.

Keeping one implementation is what stops the two clients from disagreeing about
what "our widget" means; element-web/tests/test_element_call_widget.py asserts
that this adapter really loads the desktop module.

The module is looked up in two places because the Docker build context is
element-web/ alone (the desktop tree is not in it):

  1. element-call-widget-core.py next to this file — a byte copy of the desktop
     module, committed so the context is self-contained;
  2. ../element-desktop/scripts/element-call-widget.py in the repository, so a
     checkout runs this adapter without relying on the copy.

The two are byte-identical and element-web/tests/test_element_call_widget.py
fails the pair apart on any drift, so the pin and the swap cannot fork between
the clients. $ELEMENT_CALL_WIDGET_CORE overrides both, which is how the tests
point it at a throwaway copy.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent  # element-web/scripts -> element-web -> repository root

CORE_NAME = "element-call-widget-core.py"
CORE_CANDIDATES = (
    HERE / CORE_NAME,
    REPO / "element-desktop" / "scripts" / "element-call-widget.py",
)

# The path the widget is served under in the browser client. Desktop overrides
# this with /webapp/widgets/element-call (the module's own default).
URL_PREFIX = "/widgets/element-call"


def find_core() -> Path:
    override = os.environ.get("ELEMENT_CALL_WIDGET_CORE")
    candidates = (Path(override), *CORE_CANDIDATES) if override else CORE_CANDIDATES
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    looked = "\n".join(f"  - {c}" for c in candidates)
    sys.exit(
        "element-call-widget: no checker module found. Expected "
        f"{CORE_NAME} next to this script (the Docker build context) or "
        f"element-desktop/scripts/element-call-widget.py in the repository. Looked at:\n{looked}"
    )


def prefix_from_argv(argv: list[str]) -> str:
    """The effective --url-prefix for this invocation.

    Both the installer and check_widget() read the prefix from the module's
    URL_PREFIX global (not from the parsed arguments), so the adapter resolves
    it once here and hands it to both. One prefix for one run: an install and
    the check that follows it cannot disagree about where the widget lives.
    """
    for index, arg in enumerate(argv):
        if arg == "--url-prefix" and index + 1 < len(argv):
            return argv[index + 1]
        if arg.startswith("--url-prefix="):
            return arg.split("=", 1)[1]
    return URL_PREFIX


def load_core(argv: list[str] | None = None):
    core_path = find_core()
    spec = importlib.util.spec_from_file_location("element_call_widget_core", core_path)
    if not spec or not spec.loader:
        sys.exit(f"element-call-widget: cannot import {core_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # main() builds its argparse default from this global and check_widget()
    # reads it directly, so setting it before main() is what makes the CLI
    # default to the browser mount.
    module.URL_PREFIX = prefix_from_argv(sys.argv[1:] if argv is None else argv)
    globals()["core"] = module
    return module


if __name__ == "__main__":
    load_core().main()
