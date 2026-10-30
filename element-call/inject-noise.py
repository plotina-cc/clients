#!/usr/bin/env python3
"""Insert the Plotina noise wrapper into an Element Call index.html.

The wrapper has to run before Element Call's own module bundle: it replaces
navigator.mediaDevices.getUserMedia, and the bundle is what calls it. Both tags
therefore go immediately after <head>, ahead of the <script type="module"> tag
Vite leaves in the document.

    inject-noise.py <index.html>          # patch in place, idempotent
    inject-noise.py --check <index.html>  # exit 1 unless already patched

Deliberately no defer: two same-origin files of ~30 KB total, and a deferred
script would still be behind the module script in document order.
"""

import sys
from pathlib import Path

MARKER = 'src="/noise/boot.js"'
TAGS = (
    "<script>window.__plotinaEc=true;</script>"
    '<script src="/noise/logic.js"></script>'
    '<script src="/noise/plotina-dfn.js"></script>'
    '<script src="/noise/boot.js"></script>'
    '<script src="/noise/source-link.js" defer></script>'
)


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
        print(f"{'ok' if check else 'already patched'}: {path}")
        return 0

    if check:
        print(f"error: {path} does not carry the noise wrapper", file=sys.stderr)
        return 1

    if "<head>" not in html:
        print(f"error: no <head> in {path}; upstream layout changed", file=sys.stderr)
        return 1

    # One replacement only: a second <head> would be inside a string or a comment.
    patched = html.replace("<head>", "<head>" + TAGS, 1)

    head = patched.split("</head>", 1)[0]
    module_at = head.find('type="module"')
    if module_at != -1 and head.find("/noise/boot.js") > module_at:
        print(f"error: noise tags would land after the module script in {path}", file=sys.stderr)
        return 1

    path.write_text(patched, encoding="utf-8")
    print(f"patched: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
