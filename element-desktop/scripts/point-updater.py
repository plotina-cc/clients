#!/usr/bin/env python3
"""Point the packaged updater at plotina-cc/clients.

electron-builder writes resources/app-update.yml from the app package.json's
`build.publish` block. Upstream's block names vector-im/element-web, so the
shipped app would look for (and offer) an upstream Element build. This script
rewrites that block in the app directory before `pnpm run build`; it is a
no-op when the file already points at us.

Usage (from apps/desktop, where package.json lives):
    python3 ../../element-desktop/scripts/point-updater.py
"""
from __future__ import annotations

import json
import pathlib
import sys

PUBLISH = {
    "provider": "github",
    "owner": "plotina-cc",
    "repo": "clients",
    "releaseType": "release",
}


def main() -> int:
    package = pathlib.Path("package.json")
    if not package.is_file():
        print(f"point-updater: {package.resolve()} not found", file=sys.stderr)
        return 1
    data = json.loads(package.read_text(encoding="utf-8"))
    build = data.setdefault("build", {})
    if build.get("publish") != PUBLISH:
        build["publish"] = PUBLISH
        package.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print("point-updater: publish -> plotina-cc/clients")
    else:
        print("point-updater: already plotina-cc/clients")
    return 0


if __name__ == "__main__":
    sys.exit(main())
