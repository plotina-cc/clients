#!/usr/bin/env python3
"""Apply Plotina's shell patches to an element-web apps/desktop/src tree.

    desktop/patch-shell.py [path/to/apps/desktop/src]

Two edits, both pinned with unique-context asserts so an upstream drift fails
the build loudly instead of silently shipping the old behaviour:

1. electron-main.ts — the main window's `icon` option goes through
   getMainWindowIcon() (desktop/icon.ts): Chromium cannot fit a 256x256 icon
   into one _NET_WM_ICON XChangeProperty request, so the X11 window icon is
   capped at 128x128 and the property actually gets data.

2. ipc.ts — `getUpdateFeedUrl` answers with our updater's GitHub-releases feed
   instead of Electron's Squirrel-only autoUpdater.getFeedURL(), which throws
   on Linux. The webapp hides Settings -> Help & About's "Check for updates"
   whenever that IPC has no answer (canSelfUpdate() never resolves), even
   though our AppImage/NSIS updater works fine.
"""
import sys
from pathlib import Path

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src")


def patch(path: Path, pairs: list[tuple[str, str, int]]) -> None:
    text = path.read_text(encoding="utf-8")
    for old, new, count in pairs:
        if new in text:
            continue  # already applied (idempotent)
        found = text.count(old)
        if found != count:
            sys.exit(f"patch-shell.py: {path.name}: expected {count} occurrence(s) of "
                     f"{old!r:.90}, found {found}; upstream moved - update the patch")
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8")
    print(f"patch-shell.py: {path} OK")


main = SRC / "electron-main.ts"
patch(main, [
    ('import { getIconPath } from "./icon.js";',
     'import { getIconPath, getMainWindowIcon } from "./icon.js";', 1),
    ("icon: await getIconPath(),",
     "icon: await getMainWindowIcon(),  // PLOTINA-SHELL-PATCH: X11 _NET_WM_ICON size limit", 1),
])

ipc = SRC / "ipc.ts"
patch(ipc, [
    ('import { getConfig } from "./config.js";',
     'import { getConfig } from "./config.js";\nimport { getUpdateFeedUrl } from "./updater.js";  // PLOTINA-SHELL-PATCH', 1),
    ('case "getUpdateFeedUrl":\n            ret = autoUpdater.getFeedURL();',
     'case "getUpdateFeedUrl":\n            // PLOTINA-SHELL-PATCH: autoUpdater is Squirrel/macOS only; our NSIS +\n'
     '            // AppImage updater has a real feed, so the webapp can show its\n'
     '            // "Check for updates" button on Linux too (upstream\'s call throws\n'
     '            // there, which hid the button even though updates worked).\n'
     '            ret = getUpdateFeedUrl();', 1),
])
