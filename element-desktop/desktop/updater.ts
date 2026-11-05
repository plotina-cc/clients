/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Plotina Desktop's own Windows updater. This file REPLACES
apps/desktop/src/updater.ts in the build (see the "Apply Plotina desktop
sources" step in .github/workflows/build-element-desktop.yml and
scripts/build.sh).

Why replace it: upstream's updater drives Electron's built-in autoUpdater,
which on Windows is Squirrel. Squirrel needs the Update.exe that a
`squirrel` installer ships; we package with `nsis` (Plotina-Desktop-*-setup.exe),
so upstream's updater always hits "Squirrel not found, auto update not
supported" and never runs. Upstream does not depend on electron-updater at
all, which means the resources/app-update.yml that electron-builder packs is
inert here unless something reads it.

What this does instead (Windows only, packaged builds only):
  1. Reads resources/app-update.yml — the same file CI asserts on — for the
     GitHub publish target (provider/owner/repo). The config.json
     update_base_url merely flips the code path on in electron-main.ts; this
     updater ignores its value, app-update.yml is the single source of truth.
  2. Lists GitHub releases for that owner/repo and checks the `latest.yml`
     metadata asset (electron-builder's standard) on the newest releases.
  3. Downloads the installer named by latest.yml and verifies the SHA-512
     digest that latest.yml publishes for it.
  4. Runs that installer with `/S --updated` and quits, same as
     autoUpdater.quitAndInstall() would.

SECURITY TRADE-OFF — unsigned updates, verification skipped EXPLICITLY:
  Both this app and its update installers are built without an Authenticode
  certificate, so app-update.yml carries no `publisherName`. Electron's
  electron-updater v6 (the version electron-builder 26.16.1 ships) reads a
  missing publisherName as "nothing to verify" and skips signature
  verification silently; from electron-builder v27 / electron-updater v7 the
  same state REJECTS the update (fail closed) unless app-update.yml adds
  `verifyUpdateCodeSignature: false`, a field the 26.16.1 publish schema
  refuses, so it cannot be baked in at build time here. Because that
  silent-skip / later-fail-closed behaviour is not something to rely on, this
  updater does no Authenticode verification at all and says so: the update's
  authenticity rests on (a) TLS to api.github.com / objects.githubusercontent
  and (b) the sha512 in latest.yml, which stops corruption and casual tampering
  but NOT a repo write or a GitHub account compromise — whoever can publish a
  release can push any binary this updater will run as the user. A signed
  build would fix that and then `publisherName` must appear in
  app-update.yml (electron-builder writes it automatically once signing is
  configured); users also keep seeing SmartScreen warnings on first run and
  on updates because the installer has no certificate.

IPC contract with the renderer (unchanged from upstream so the web UI keeps
working): sends `check_updates` with true / false / error string, sends
`update-downloaded` with { releaseNotes, releaseName, releaseDate, updateURL
}, receives `install_update` and `check_updates`.
*/

import { app, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";

const UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // GitHub's API allows 60 req/h/IP; don't burn the budget
const INITIAL_UPDATE_DELAY_MS = 30 * 1000;
// Number of most recent releases whose latest.yml we actually fetch.
const MAX_METADATA_CHECKS = 5;

interface UpdateFeed {
    owner: string;
    repo: string;
}

interface ReleaseAsset {
    name: string;
    browser_download_url: string;
}

interface Release {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    assets: ReleaseAsset[];
}

interface LatestYml {
    version: string;
    fileName: string;
    sha512: string;
    releaseDate: string;
}

interface ICachedUpdate {
    releaseNotes: string;
    releaseName: string;
    releaseDate: Date;
    updateURL: string;
}

let pendingUpdate: ICachedUpdate & { installerPath: string } | null = null;
let checking = false;
let lastNotifiedVersion: string | null = null;

/**
 * electron-builder writes resources/app-update.yml from the publish config
 * (`--config.publish.*` CLI overrides in our build; owner/repo are ours,
 * asserted by CI and by the windows smoke job).
 */
function readUpdateFeed(): UpdateFeed | null {
    const ymlPath = path.join(process.resourcesPath, "app-update.yml");
    let text: string;
    try {
        text = fsSync.readFileSync(ymlPath, "utf8");
    } catch {
        return null;
    }
    const field = (name: string): string => {
        const line = text.split(/\r?\n/).find((l) => l.startsWith(name + ":"));
        return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : "";
    };
    if (field("provider") !== "github") return null;
    const owner = field("owner");
    const repo = field("repo");
    if (!owner || !repo) return null;
    return { owner, repo };
}

/** Numeric tokens of a version: "1.12.32-plotina.30" -> [1,12,32,30]. */
function versionNumbers(version: string): number[] {
    return version
        .split(/[.\-+_]/)
        .filter((part) => /^\d+$/.test(part))
        .map(Number);
}

function isVersionNewer(candidate: string, current: string): boolean {
    const a = versionNumbers(candidate);
    const b = versionNumbers(current);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    return false;
}

/** electron-builder's latest.yml: we need version, installer name, sha512. */
function parseLatestYml(text: string): LatestYml | null {
    const grab = (re: RegExp): string | null => {
        const m = re.exec(text);
        if (!m) return null;
        return m[1].trim().replace(/^["']|["']$/g, "");
    };
    const version = grab(/^version:\s*(.+)$/m);
    // first `url:` entry of the files list
    const fileName = grab(/^files:[\s\S]*?-\s*url:\s*(.+)$/m);
    // top-level (column-0) sha512 covers the installer itself
    const sha512 = grab(/^sha512:\s*(.+)$/m);
    const releaseDate = grab(/^releaseDate:\s*(.+)$/m);
    if (!version || !fileName || !sha512) return null;
    return { version, fileName, sha512, releaseDate: releaseDate ?? "" };
}

function sendUpdateStatus(status: boolean | string): void {
    global.mainWindow?.webContents.send("check_updates", status);
}

function sendUpdateDownloaded(update: ICachedUpdate): void {
    global.mainWindow?.webContents.send("update-downloaded", update);
}

async function checkForUpdates(manual: boolean): Promise<void> {
    const feed = readUpdateFeed();
    if (!feed) {
        if (manual) sendUpdateStatus(false);
        return;
    }
    if (checking) return;
    checking = true;
    try {
        if (pendingUpdate) {
            // Upstream does the same: a downloaded update is re-shown rather than re-fetched.
            sendUpdateDownloaded(pendingUpdate);
            return;
        }
        const res = await fetch(`https://api.github.com/repos/${feed.owner}/${feed.repo}/releases?per_page=100`, {
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": `Plotina-Desktop/${app.getVersion()}`,
            },
        });
        if (!res.ok) throw new Error(`GitHub releases responded HTTP ${res.status}`);
        const releases = (await res.json()) as Release[];
        const candidates = releases
            .filter((r) => !r.draft && !r.prerelease && r.assets.some((a) => a.name === "latest.yml"))
            .slice(0, MAX_METADATA_CHECKS);

        let best: { release: Release; yml: LatestYml } | null = null;
        for (const release of candidates) {
            const ymlAsset = release.assets.find((a) => a.name === "latest.yml")!;
            const ymlRes = await fetch(ymlAsset.browser_download_url, {
                headers: { "User-Agent": `Plotina-Desktop/${app.getVersion()}` },
            });
            if (!ymlRes.ok) continue;
            const yml = parseLatestYml(await ymlRes.text());
            if (!yml) continue;
            if (!isVersionNewer(yml.version, app.getVersion())) continue;
            if (!best || isVersionNewer(yml.version, best.yml.version)) {
                best = { release, yml };
            }
        }

        if (!best) {
            if (manual) sendUpdateStatus(false);
            return;
        }

        sendUpdateStatus(true); // "update-available" equivalent
        await downloadAndVerify(best.release, best.yml);
    } catch (e) {
        console.warn("Plotina updater: check failed", e);
        if (manual) sendUpdateStatus(e instanceof Error ? e.message : String(e));
    } finally {
        checking = false;
    }
}

async function downloadAndVerify(release: Release, yml: LatestYml): Promise<void> {
    const installerAsset = release.assets.find((a) => a.name === yml.fileName);
    if (!installerAsset) {
        throw new Error(`Release ${release.tag_name} has no asset named ${yml.fileName}`);
    }
    const dir = path.join(app.getPath("userData"), "plotina-updates");
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, installerAsset.name);

    if (await matchesSha512(dest, yml.sha512)) {
        console.log(`Plotina updater: reusing verified download ${dest}`);
    } else {
        console.log(`Plotina updater: downloading ${installerAsset.browser_download_url}`);
        const res = await fetch(installerAsset.browser_download_url, {
            headers: { "User-Agent": `Plotina-Desktop/${app.getVersion()}` },
        });
        if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
        // Write to a temp name so a half-written file can never look verified.
        const tmp = dest + ".part";
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
        await fs.rm(dest, { force: true });
        await fs.rename(tmp, dest);
        if (!(await matchesSha512(dest, yml.sha512))) {
            await fs.rm(dest, { force: true });
            throw new Error(`sha512 mismatch for ${yml.fileName}; refusing to install`);
        }
    }

    pendingUpdate = {
        releaseNotes: "",
        releaseName: yml.version,
        releaseDate: new Date(yml.releaseDate || Date.now()),
        updateURL: installerAsset.browser_download_url,
        installerPath: dest,
    };
    sendUpdateDownloaded(pendingUpdate);
    if (lastNotifiedVersion !== yml.version) {
        lastNotifiedVersion = yml.version;
        // The installer is unsigned: see the security note at the top.
        void dialog
            .showMessageBox({
                type: "info",
                title: "Plotina Desktop",
                message: `Plotina Desktop ${yml.version} is downloaded.`,
                detail:
                    "Restart to install the update. The installer is checked against the sha512 " +
                    "published with the release; it is not code-signed.",
                buttons: ["Restart to update", "Later"],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
            })
            .then(({ response }) => {
                if (response === 0) installUpdate();
            });
    }
}

async function matchesSha512(file: string, expected: string): Promise<boolean> {
    try {
        const data = await fs.readFile(file);
        return createHash("sha512").update(data).digest("base64") === expected;
    } catch {
        return false;
    }
}

function installUpdate(): void {
    if (!pendingUpdate) {
        console.log("Plotina updater: nothing to install");
        return;
    }
    // For the same reason quitAndInstall sets it: before-quit handlers should persist state now.
    global.appQuitting = true;
    // /S = silent NSIS, --updated = "this is an update, not a first install".
    // electron-builder's NSIS script force-closes the running app in silent mode,
    // and app.quit() races gracefully with it; the app-own lock makes double-launch safe.
    const child = spawn(pendingUpdate.installerPath, ["/S", "--updated"], { detached: true, stdio: "ignore" });
    child.on("error", (e) => console.error("Plotina updater: failed to start installer", e));
    child.unref();
    app.quit();
}

ipcMain.on("install_update", () => installUpdate());
ipcMain.on("check_updates", () => void checkForUpdates(true));

/**
 * Called from electron-main.ts when config.json has an update_base_url and
 * --no-update was not passed. The URL is ignored on purpose: the feed comes
 * from app-update.yml (owner/repo), which CI guarantees to be plotina-cc/clients.
 */
export async function start(_updateBaseUrl: string): Promise<void> {
    if (process.platform !== "win32") {
        // Linux/macOS builds are packaged manually (AppImage/deb), matching upstream's stance.
        console.warn("Plotina updater: auto update not supported on this platform");
        return;
    }
    if (!app.isPackaged) {
        console.log("Plotina updater: unpackaged development build, auto update disabled");
        return;
    }
    const feed = readUpdateFeed();
    if (!feed) {
        console.warn(`Plotina updater: no usable GitHub feed in ${path.join(process.resourcesPath, "app-update.yml")}, auto update disabled`);
        return;
    }
    console.log(`Plotina updater: checking ${feed.owner}/${feed.repo} releases for a newer version than ${app.getVersion()}`);
    setTimeout(() => void checkForUpdates(false), INITIAL_UPDATE_DELAY_MS);
    setInterval(() => void checkForUpdates(false), UPDATE_POLL_INTERVAL_MS);
}
