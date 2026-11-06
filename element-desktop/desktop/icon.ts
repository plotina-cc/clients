/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Plotina's replacement for apps/desktop/src/icon.ts. Copied over the upstream
file by scripts/build.sh and the CI workflow (same pattern as updater.ts).

Difference from upstream: getMainWindowIcon(), used by electron-main.ts for the
main BrowserWindow's `icon` option (see desktop/patch-shell.py).

Why: on X11 Electron writes _NET_WM_ICON with the window icon through a single
XChangeProperty request whose payload is width*height*4 + 8 CARDINALs. A
256x256 PNG — the size electron-builder packs into resources/build/icon.png —
needs 262,152 bytes, which exceeds the X protocol's 262,140-byte request limit:
the server answers BadLength and the property is left empty, so KDE's window
switcher and any WM that reads _NET_WM_ICON shows a generic/black icon. A
128x128 icon fits (65,544 B) and populates the property; measured against
Electron 44.4.5 both in the packaged AppImage and in vanilla upstream builds
(<=128px -> "Icon (128 x 128)", >=256px -> empty property). KDE scales the
128px icon for the switcher; the launcher/taskbar icon still comes from the
hicolor theme via StartupWMClass.
*/

import path from "node:path";

import { nativeImage } from "electron";
import type { NativeImage } from "electron";

import { getAsarPath } from "./asar.js";

// Keep the exported name and behaviour upstream relies on (tray.ts, tests).
export async function getIconPath(): Promise<string> {
    const asarPath = await getAsarPath();

    const iconFile = `icon.${process.platform === "win32" ? "ico" : "png"}`;
    return path.join(path.dirname(asarPath), "build", iconFile);
}

// Largest window icon Chromium can serialize into the _NET_WM_ICON X property
// in one request. See the file header.
const MAX_X11_WINDOW_ICON_PX = 128;

/**
 * The icon for BrowserWindow's `icon` option. On Linux this is a NativeImage
 * capped at 128x128 so Chromium actually fills _NET_WM_ICON; elsewhere the
 * original path (Windows wants the full multi-size .ico, macOS ignores it).
 */
export async function getMainWindowIcon(): Promise<string | NativeImage> {
    const iconPath = await getIconPath();
    if (process.platform !== "linux") {
        return iconPath;
    }
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
        // Same degraded behaviour as upstream: a bad path simply yields no icon.
        return iconPath;
    }
    const { width, height } = image.getSize();
    if (width <= MAX_X11_WINDOW_ICON_PX && height <= MAX_X11_WINDOW_ICON_PX) {
        return image;
    }
    return image.resize({ width: MAX_X11_WINDOW_ICON_PX, height: MAX_X11_WINDOW_ICON_PX });
}
