#!/usr/bin/env python3
"""Insert the Plotina noise wrapper into an Element Call index.html.

The wrapper has to run before Element Call's own module bundle: it replaces
navigator.mediaDevices.getUserMedia, and the bundle is what calls it. The tags
therefore go immediately after <head>, ahead of the <script type="module"> tag
Vite leaves in the document. plotina-panel.js is the in-call level control; it
is a classic script too and sits after plotina-dfn.js, whose
window.__plotinaSetLevel() it calls.

    inject-noise.py <index.html>          # patch in place, idempotent
    inject-noise.py --check <index.html>  # exit 1 unless already patched

A bundle that carries the older wrapper (boot.js but no panel) is upgraded in
place: the panel tag is added after the boot tag, nothing else moves. That is
what makes a static deploy of one new file possible on the edge.

Deliberately no defer: two same-origin files of ~30 KB total, and a deferred
script would still be behind the module script in document order.
"""

import sys
from pathlib import Path

MARKER = 'src="/noise/boot.js"'
BOOT_TAG = '<script src="/noise/boot.js"></script>'
PANEL_TAG = '<script src="/noise/plotina-panel.js"></script>'
PANEL_MARKER = 'src="/noise/plotina-panel.js"'
TAGS = (
    "<script>window.__plotinaEc=true;</script>"
    '<script src="/noise/logic.js"></script>'
    '<script src="/noise/plotina-dfn.js"></script>'
    + BOOT_TAG
    + PANEL_TAG
    + '<script src="/noise/source-link.js" defer></script>'
)


def in_order(html: str) -> bool:
    """The wrapper must be present and ahead of the module script."""
    head = html.split("</head>", 1)[0]
    module_at = head.find('type="module"')
    if module_at == -1:
        return True
    for marker in (MARKER, PANEL_MARKER):
        at = head.find(marker)
        if at == -1 or at > module_at:
            return False
    return True


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

    if MARKER in html:
        if PANEL_MARKER in html:
            print(f"{'ok' if check else 'already patched'}: {path}")
            return 0
        if check:
            print(f"error: {path} has the wrapper but no level panel", file=sys.stderr)
            return 1
        at = html.find(BOOT_TAG)
        if at != -1:
            at += len(BOOT_TAG)
        else:
            at = html.find(">", html.find(MARKER)) + 1
        patched = html[:at] + PANEL_TAG + html[at:]
        if not in_order(patched):
            print(f"error: the panel tag would land after the module script in {path}", file=sys.stderr)
            return 1
        path.write_text(patched, encoding="utf-8")
        print(f"patched (panel tag added): {path}")
        return 0

    if check:
        print(f"error: {path} does not carry the noise wrapper", file=sys.stderr)
        return 1

    if "<head>" not in html:
        print(f"error: no <head> in {path}; upstream layout changed", file=sys.stderr)
        return 1

    # One replacement only: a second <head> would be inside a string or a comment.
    patched = html.replace("<head>", "<head>" + TAGS, 1)

    if not in_order(patched):
        print(f"error: noise tags would land after the module script in {path}", file=sys.stderr)
        return 1

    path.write_text(patched, encoding="utf-8")
    print(f"patched: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
