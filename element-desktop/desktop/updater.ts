/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Plotina Desktop's own Windows + Linux updater. This file REPLACES
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

What this does instead (Windows NSIS + Linux AppImage, packaged builds only):
  1. Reads resources/app-update.yml — the same file CI asserts on — for the
     GitHub publish target (provider/owner/repo). The config.json
     update_base_url merely flips the code path on in electron-main.ts; this
     updater ignores its value, app-update.yml is the single source of truth.
  2. Lists GitHub releases for that owner/repo and checks the metadata asset
     (electron-builder's standard) on the newest releases: `latest.yml` on
     Windows, `latest-linux.yml` on Linux (AppImage).
  3. Downloads the artifact named by that yml and verifies the SHA-512
     digest it publishes.
  4. Windows: runs the installer with `/S --updated` and quits, same as
     autoUpdater.quitAndInstall() would.
     Linux (AppImage runtime, process.env.APPIMAGE set): the verified image is
     written next to the running one, chmod +x, then swapped in with an atomic
     rename over the current AppImage (POSIX rename is legal while the old
     file is still open by the FUSE mount: the running process keeps the old
     inode, the directory entry gets the new bytes). "Restart" re-spawns the
     same path, which is now the new image. If the directory is not writable
     the verified file is saved to the user's Downloads and the dialog prints
     the path instead; the running image is left untouched.
     Linux (deb or other system install): updates come from the package
     manager; the updater logs that guidance and stays off.
     macOS: unsupported, as before.

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
// Number of most recent releases whose metadata we actually fetch.
const MAX_METADATA_CHECKS = 5;
// electron-builder's per-platform metadata asset.
const WINDOWS_METADATA_FILE = "latest.yml";
const LINUX_METADATA_FILE = "latest-linux.yml";

type UpdateMode = "windows-installer" | "linux-appimage" | "linux-deb" | "unsupported";

/**
 * Which update path applies. On Linux we only self-update when running from
 * an AppImage: the runtime sets APPIMAGE to the image path, and only that
 * file is ours to replace. A deb/system install is owned by the package
 * manager (dpkg locks its files and `apt upgrade` is the update path).
 */
export function detectUpdateMode(platform: string, env: Record<string, string | undefined>): UpdateMode {
    if (platform === "win32") return "windows-installer";
    if (platform === "linux") {
        if (env.APPIMAGE) return "linux-appimage";
        return "linux-deb";
    }
    return "unsupported";
}

const UPDATE_MODE = detectUpdateMode(process.platform, process.env);

/**
 * Feed string the webapp asks for through ipc.ts' "getUpdateFeedUrl"
 * (desktop/patch-shell.py wires it here). HelpUserSettingsTab shows the
 * "Check for updates" button only when canSelfUpdate() =
 * Boolean(await ipcCall("getUpdateFeedUrl")) is true, and awaiting an IPC the
 * main process never answers because upstream's autoUpdater.getFeedURL()
 * threw hangs that promise forever. Upstream's autoUpdater is
 * Squirrel/macOS-only and this updater replaces it, so answer from here:
 * a non-empty feed exactly where installUpdate() can actually update —
 * NSIS Windows, and Linux when running from an AppImage. A deb install
 * updates through apt, so it reports no feed and the webapp hides the
 * button, as before.
 */
export const PLOTINA_RELEASES_FEED = "https://github.com/plotina-cc/clients/releases";

export function plotinaUpdateFeed(platform: string, env: Record<string, string | undefined>): string {
    const mode = detectUpdateMode(platform, env);
    return mode === "windows-installer" || mode === "linux-appimage" ? PLOTINA_RELEASES_FEED : "";
}

export function getUpdateFeedUrl(): string {
    return plotinaUpdateFeed(process.platform, process.env);
}

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
// Linux notifies per (version, outcome): "…:swapped" restart dialog vs "…:saved" fallback note.
let lastNotifiedKey: string | null = null;

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

export function isVersionNewer(candidate: string, current: string): boolean {
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
export function parseLatestYml(text: string): LatestYml | null {
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

export async function checkForUpdates(manual: boolean): Promise<void> {
    if (UPDATE_MODE === "unsupported") {
        if (manual) sendUpdateStatus(false);
        return;
    }
    if (UPDATE_MODE === "linux-deb") {
        // deb/system install: dpkg owns the files, `apt upgrade` is the update path.
        if (manual) sendUpdateStatus(DEB_UPDATE_GUIDANCE);
        return;
    }
    const feed = readUpdateFeed();
    if (!feed) {
        if (manual) sendUpdateStatus(false);
        return;
    }
    if (checking) return;
    checking = true;
    const metadataFile = UPDATE_MODE === "linux-appimage" ? LINUX_METADATA_FILE : WINDOWS_METADATA_FILE;
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
            .filter((r) => !r.draft && !r.prerelease && r.assets.some((a) => a.name === metadataFile))
            .slice(0, MAX_METADATA_CHECKS);

        let best: { release: Release; yml: LatestYml } | null = null;
        for (const release of candidates) {
            const ymlAsset = release.assets.find((a) => a.name === metadataFile)!;
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
        if (UPDATE_MODE === "linux-appimage") {
            await downloadAndSwapAppImage(best.release, best.yml);
        } else {
            await downloadAndVerify(best.release, best.yml);
        }
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
export { matchesSha512 as _matchesSha512ForTests };

export const DEB_UPDATE_GUIDANCE =
    "Plotina Desktop (deb/system install) is updated by the package manager: run `sudo apt update && sudo apt upgrade`.";

/** The image file we run from, with symlinks resolved so the swap hits the real file. */
function resolveCurrentAppImage(): string {
    const raw = process.env.APPIMAGE!;
    try {
        return fsSync.realpathSync(raw);
    } catch {
        return raw;
    }
}

function isDirWritable(dir: string): boolean {
    try {
        fsSync.accessSync(dir, fsSync.constants.W_OK | fsSync.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Download the new AppImage to a temp file next to the running image (or in
 * userData when that directory is not writable — we cannot even create a
 * temp file in a directory we cannot write to). The bytes only become the
 * staging file after the sha512 check passes, so a half-downloaded or
 * corrupted file can never be swapped in, and a crash leaves at most a
 * `*.part` that the next run deletes.
 */
export async function stageAppImage(downloadUrl: string, currentPath: string, expectedSha512: string, assetName: string): Promise<string> {
    const dir = path.dirname(currentPath);
    const stagingDir = isDirWritable(dir) ? dir : path.join(app.getPath("userData"), "plotina-updates");
    await fs.mkdir(stagingDir, { recursive: true });
    const staged = path.join(stagingDir, `${assetName}.plotina-new`);
    const part = `${staged}.part`;
    await fs.rm(part, { force: true }); // never reuse a half-written temp file

    if (await matchesSha512(staged, expectedSha512)) {
        console.log(`Plotina updater: reusing verified staged image ${staged}`);
        return staged;
    }
    console.log(`Plotina updater: downloading ${downloadUrl}`);
    const res = await fetch(downloadUrl, { headers: { "User-Agent": `Plotina-Desktop/${app.getVersion()}` } });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    if (!(await matchesSha512(part, expectedSha512))) {
        await fs.rm(part, { force: true });
        throw new Error(`sha512 mismatch for ${assetName}; the running AppImage was left untouched`);
    }
    await fs.chmod(part, 0o755);
    await fs.rename(part, staged); // only verified bytes exist under the staging name
    return staged;
}

export interface AppImageSwapResult {
    swapped: boolean;
    /** When not swapped: where the verified image ended up instead. */
    savedTo?: string;
    reason?: string;
}

/**
 * Atomically replace the running AppImage with the staged one.
 * rename() within the same directory is atomic and legal while the old file
 * is open by the AppImage runtime's FUSE mount. If that fails (different
 * filesystem, or a directory we cannot write to) we retry via copy-into-dir
 * + rename, and as a last resort keep the verified image in fallbackDir and
 * tell the user where it is. The old AppImage is only ever removed by a
 * successful rename over it.
 */
export async function swapAppImage(stagedPath: string, currentPath: string, fallbackDir: string): Promise<AppImageSwapResult> {
    try {
        await fs.rename(stagedPath, currentPath);
        // The new directory entry carries the staged file's mode; make the
        // image executable regardless of how the staged file got there.
        await fs.chmod(currentPath, 0o755).catch(() => {});
        return { swapped: true };
    } catch (e) {
        console.warn("Plotina updater: rename-over-AppImage failed", e);
    }
    // Cross-filesystem or otherwise awkward: copy in, then rename locally.
    try {
        const inDirTmp = `${currentPath}.plotina-new`;
        await fs.copyFile(stagedPath, inDirTmp);
        await fs.chmod(inDirTmp, 0o755);
        await fs.rename(inDirTmp, currentPath);
        await fs.rm(stagedPath, { force: true });
        return { swapped: true };
    } catch (e) {
        console.warn("Plotina updater: copy-into-directory also failed", e);
    }
    // Last resort: hand the verified file to the user.
    try {
        await fs.mkdir(fallbackDir, { recursive: true });
        const savedTo = path.join(fallbackDir, path.basename(stagedPath).replace(/\.plotina-new$/, ""));
        await fs.copyFile(stagedPath, savedTo);
        await fs.chmod(savedTo, 0o755);
        return { swapped: false, savedTo, reason: "AppImage directory is not writable" };
    } catch (e) {
        return { swapped: false, reason: e instanceof Error ? e.message : String(e) };
    }
}

function downloadsDir(): string {
    try {
        return app.getPath("downloads");
    } catch {
        return path.join(app.getPath("home"), "Downloads");
    }
}

/**
 * Linux AppImage path: fetch metadata, download + verify, swap in place, then
 * show the same renderer "update-downloaded" flow as Windows with a dialog
 * offering a restart into the new image.
 */
async function downloadAndSwapAppImage(release: Release, yml: LatestYml): Promise<void> {
    if (!yml.fileName.endsWith(".AppImage")) {
        throw new Error(`latest-linux.yml names ${yml.fileName}, which is not an AppImage`);
    }
    const asset = release.assets.find((a) => a.name === yml.fileName);
    if (!asset) {
        throw new Error(`Release ${release.tag_name} has no asset named ${yml.fileName}`);
    }
    const currentPath = resolveCurrentAppImage();
    const staged = await stageAppImage(asset.browser_download_url, currentPath, yml.sha512, yml.fileName);
    const swap = await swapAppImage(staged, currentPath, downloadsDir());

    if (!swap.swapped) {
        console.warn(`Plotina updater: could not replace ${currentPath} (${swap.reason ?? "unknown"})`);
        const savedNote = swap.savedTo ? `Saved to ${swap.savedTo} — replace the old AppImage with it, then launch that file.` : "No verified copy could be saved either.";
        if (lastNotifiedKey !== `${yml.version}:saved`) {
            lastNotifiedKey = `${yml.version}:saved`;
            void dialog.showMessageBox({
                type: "info",
                title: "Plotina Desktop",
                message: `Plotina Desktop ${yml.version} was downloaded but cannot replace the running AppImage.`,
                detail: `${savedNote}\n(${swap.reason ?? ""})`,
                buttons: ["OK"],
                noLink: true,
            });
        }
        return;
    }

    pendingUpdate = {
        releaseNotes: "",
        releaseName: yml.version,
        releaseDate: new Date(yml.releaseDate || Date.now()),
        updateURL: asset.browser_download_url,
        installerPath: currentPath, // already swapped: "install" = restart into it
    };
    sendUpdateDownloaded(pendingUpdate);
    if (lastNotifiedKey !== `${yml.version}:swapped`) {
        lastNotifiedKey = `${yml.version}:swapped`;
        void dialog
            .showMessageBox({
                type: "info",
                title: "Plotina Desktop",
                message: `Plotina Desktop ${yml.version} has been installed over the old AppImage.`,
                detail:
                    "Restart to run the new version. The image is checked against the sha512 published " +
                    "with the release; it is not code-signed.",
                buttons: ["Restart now", "Later"],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
            })
            .then(({ response }) => {
                if (response === 0) installUpdate();
            });
    }
}

export function installUpdate(spawnImpl: typeof spawn = spawn): void {
    if (!pendingUpdate) {
        console.log("Plotina updater: nothing to install");
        return;
    }
    // For the same reason quitAndInstall sets it: before-quit handlers should persist state now.
    global.appQuitting = true;
    if (UPDATE_MODE === "linux-appimage") {
        // The swap already happened; "install" just relaunches the same path,
        // which now holds the new image. No args: a plain start, like the NSIS
        // runAfterFinish relaunch on Windows. The single-instance lock makes
        // the overlap until app.quit() safe.
        const target = resolveCurrentAppImage();
        const child = spawnImpl(target, [], { detached: true, stdio: "ignore" });
        child.on("error", (e) => console.error("Plotina updater: failed to restart the new AppImage", e));
        child.unref();
        app.quit();
        return;
    }
    // /S = silent NSIS, --updated = "this is an update, not a first install".
    // electron-builder's NSIS script force-closes the running app in silent mode,
    // and app.quit() races gracefully with it; the app-own lock makes double-launch safe.
    const child = spawnImpl(pendingUpdate.installerPath, ["/S", "--updated"], { detached: true, stdio: "ignore" });
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
    if (UPDATE_MODE === "unsupported") {
        console.warn(`Plotina updater: auto update not supported on this platform (${process.platform})`);
        return;
    }
    if (UPDATE_MODE === "linux-deb") {
        // Not an AppImage: this is a deb (or otherwise system-installed) copy.
        // dpkg owns /opt/...; touching it from here would break package
        // integrity. `apt upgrade` is the update path.
        console.log(`Plotina updater: ${DEB_UPDATE_GUIDANCE}`);
        return;
    }
    if (UPDATE_MODE === "linux-appimage") {
        console.log(`Plotina updater: running as AppImage at ${process.env.APPIMAGE}`);
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
    const metadataFile = UPDATE_MODE === "linux-appimage" ? LINUX_METADATA_FILE : WINDOWS_METADATA_FILE;
    console.log(`Plotina updater: checking ${feed.owner}/${feed.repo} releases (${metadataFile}) for a newer version than ${app.getVersion()}`);
    setTimeout(() => void checkForUpdates(false), INITIAL_UPDATE_DELAY_MS);
    setInterval(() => void checkForUpdates(false), UPDATE_POLL_INTERVAL_MS);
}
