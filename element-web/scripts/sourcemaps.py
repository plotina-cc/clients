#!/usr/bin/env python3
"""Lay out Element Web's shipped source maps for a GlitchTip upload.

Element Web is not built here: we run the pinned upstream image, which already
ships the maps next to its bundles -- that is why
https://chat.plotina.cc/bundles/<hash>/bundle.js.map answers. Those are the
only maps that describe the exact bytes our users load, so this script copies
them (and the JS they belong to) into a directory laid out for

    sentry-cli sourcemaps upload --release <release> --url-prefix '~/bundles' <out>

and prints the release the bundle was built with. matrix-react-sdk's
initSentry() passes process.env.VERSION, which upstream bakes into the bundle;
config.json has no release key, so reading it back from the shipped JS is the
only way to keep events and maps under the same name.

    sourcemaps.py --webapp /app --out dist/sourcemaps
    sourcemaps.py --webapp /app --check        # layout and release only
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path
from typing import NoReturn

# release:"1.12.32" in the minified initSentry() call. The SDK also contains
# release:"string" (a typeof guard); anything without a digit is not a version.
RELEASE_RE = re.compile(r'release:"([^"]{1,64})"')
BUNDLES = "bundles"


def fail(message: str) -> NoReturn:
    print(f"sourcemaps: {message}", file=sys.stderr)
    raise SystemExit(1)


def discover_release(webapp: Path) -> str:
    """Return the single release string baked into the shipped bundles."""
    bundles = webapp / BUNDLES
    if not bundles.is_dir():
        fail(f"{bundles} does not exist; is --webapp the Element Web root (/app)?")

    found: dict[str, set[str]] = {}
    for js in bundles.rglob("*.js"):
        text = js.read_text(encoding="utf-8", errors="replace")
        for match in RELEASE_RE.finditer(text):
            value = match.group(1)
            if value == "string" or not any(ch.isdigit() for ch in value):
                continue
            found.setdefault(value, set()).add(str(js.relative_to(webapp)))

    if not found:
        fail("no release:\"<version>\" literal in the bundles; upstream changed initSentry() and the maps would be orphaned")
    if len(found) > 1:
        detail = ", ".join(f"{value} ({len(paths)} file(s))" for value, paths in sorted(found.items()))
        fail(f"more than one release in the bundles: {detail}")

    return next(iter(found))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--webapp", type=Path, required=True, help="extracted Element Web root, e.g. /app or dist/webapp")
    parser.add_argument("--out", type=Path, help="copy the maps here, laid out relative to the webapp root")
    parser.add_argument("--check", action="store_true", help="validate the layout and print the release without copying")
    args = parser.parse_args()

    release = discover_release(args.webapp)
    maps = sorted((args.webapp / BUNDLES).rglob("*.js.map"))
    if not maps:
        fail("the build has no .js.map files; nothing to upload and no symbolication would be possible")

    if args.out:
        for source in maps:
            target = args.out / source.relative_to(args.webapp)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            # sentry-cli pairs each map with the script it describes and checks
            # the sourceMappingURL; a copy is enough, it is never served.
            script = source.with_suffix("")
            if script.is_file():
                shutil.copy2(script, args.out / script.relative_to(args.webapp))
        print(f"sourcemaps: selected {len(maps)} map(s) from {len({m.parent for m in maps})} bundle directories")

    print(f"maps={len(maps)}")
    print(f"release={release}")


if __name__ == "__main__":
    main()
