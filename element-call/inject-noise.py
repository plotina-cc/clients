#!/usr/bin/env python3
"""Insert the Plotina noise wrapper into an Element Call index.html.

The wrapper has to run before Element Call's own module bundle: it replaces
navigator.mediaDevices.getUserMedia, and the bundle is what calls it. The tags
therefore go immediately after <head>, ahead of the <script type="module"> tag
Vite leaves in the document. plotina-dfn.js is the DeepFilterNet3 track
processor; the level control is not a script at all — it is the noise
suppression row in the call's own Settings -> Audio tab.

    inject-noise.py <index.html>          # patch in place, idempotent
    inject-noise.py --check <index.html>  # exit 1 unless already patched

A bundle that still carries the old floating level panel is upgraded in place:
the panel tag is removed, nothing else moves. That is what makes a static deploy
of one new file possible on the edge. `--check` fails on such a bundle, because
the file it advertises, /noise/plotina-panel.js, is no longer shipped.

Deliberately no defer: two same-origin files of ~40 KB total, and a deferred
script would still be behind the module script in document order.
"""

import sys
from pathlib import Path

MARKER = 'src="/noise/boot.js"'
BOOT_TAG = '<script src="/noise/boot.js"></script>'
# Written by every release up to the one that moved the level into the settings
# modal. Taking it out is the whole upgrade path for a static deploy.
PANEL_TAG = '<script src="/noise/plotina-panel.js"></script>'
PANEL_MARKER = 'src="/noise/plotina-panel.js"'
TAGS = (
    "<script>window.__plotinaEc=true;</script>"
    '<script src="/noise/logic.js"></script>'
    '<script src="/noise/plotina-dfn.js"></script>'
    + BOOT_TAG
    + '<script src="/noise/source-link.js" defer></script>'
)


def in_order(html: str) -> bool:
    """The wrapper must be present and ahead of the module script."""
    head = html.split("</head>", 1)[0]
    module_at = head.find('type="module"')
    if module_at == -1:
        return True
    at = head.find(MARKER)
    return at != -1 and at < module_at


def without_panel(html: str) -> str:
    """The old in-call level panel, taken out of a shell that still carries it."""
    return html.replace(PANEL_TAG, "")


def main(argv: list[str]) -> int:
    check = False
    args = argv[1:]
    if args and args[0] == "--check":
        check = True
        args = args[1:]
    if len(args) != 1:
        print("usage: inject-noise.py [--check] <index.html>", file=sys.stderr)
        return 2

    path = Path(args[0])
    if not path.is_file():
        print(f"error: {path} does not exist", file=sys.stderr)
        return 2

    html = path.read_text(encoding="utf-8")

    if check:
        if MARKER not in html:
            print(f"error: {path} does not carry the noise wrapper", file=sys.stderr)
            return 1
        if PANEL_MARKER in html:
            print(
                f"error: {path} still loads the floating noise panel "
                f"({PANEL_TAG}); the level lives in Settings -> Audio now",
                file=sys.stderr,
            )
            return 1
        if not in_order(html):
            print(
                f"error: the noise wrapper is behind the module script in {path}",
                file=sys.stderr,
            )
            return 1
        print(f"ok: {path}")
        return 0

    if MARKER in html:
        stripped = without_panel(html)
        if stripped == html:
            print(f"already patched: {path}")
            return 0
        if not in_order(stripped):
            print(
                f"error: removing the panel would leave the wrapper behind the "
                f"module script in {path}",
                file=sys.stderr,
            )
            return 1
        path.write_text(stripped, encoding="utf-8")
        print(f"patched (floating noise panel removed): {path}")
        return 0

    if "<head>" not in html:
        print(f"error: no <head> in {path}; upstream layout changed", file=sys.stderr)
        return 1

    # One replacement only: a second <head> would be inside a string or a comment.
    patched = without_panel(html.replace("<head>", "<head>" + TAGS, 1))

    if not in_order(patched):
        print(f"error: noise tags would land after the module script in {path}", file=sys.stderr)
        return 1

    path.write_text(patched, encoding="utf-8")
    print(f"patched: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
