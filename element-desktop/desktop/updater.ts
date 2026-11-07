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

 * IPC contract with the renderer (unchanged from upstream so the web UI keeps
working): sends `check_updates` with true / false / error string, sends
`update-downloaded` with { releaseNotes, releaseName, releaseDate, updateURL
}, receives `install_update` and `check_updates`. ipc.ts is additionally
patched (patch-shell.py) to answer the webapp's `ipcCall`s
`getUpdateChannel` / `setUpdateChannel` from here.

UPDATE CHANNELS (opt-in, default stable):
  - stable: the GitHub release listing of plotina-cc/clients, latest.yml
    (Windows NSIS) / latest-linux.yml (Linux AppImage), strictly-newer only.
  - dev:    the rolling release tag `dev-latest` — latest-dev.yml /
    latest-linux-dev.yml read as direct assets (no API listing). Dev builds
    carry a normal semver-prerelease version (4.12.8-plotina.<N>-dev.<M>) and
    compare normally; returning to stable is a normal strictly-newer check,
    and the explicit user-confirmed "Вернуться на стабильный" (setUpdateChannel
    with allowDowngrade, honoured only on a running -dev build) may install an
    older stable release through the same verified restart-to-update flow.
    Switching channels forgets any pending downloaded update.
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
// This repository hosts every client; a release is only a Desktop release if
// its tag carries the Desktop marker. Without this, the Lite release (semver
// 4.12.8 > Desktop 1.12.32) was picked as an "update" and its AppImage
// replaced Plotina Desktop — the Desktop -> Lite downgrade seen in the wild.
const DESKTOP_RELEASE_TAG = /^v\d+\.\d+\.\d+-plotina-(?:desktop|element)\.\d+(?:-dev\.\d+)?$/;

export function isDesktopReleaseTag(tag: string): boolean {
    return DESKTOP_RELEASE_TAG.test(tag);
}
// Dev channel: one rolling GitHub release (tag `dev-latest`) whose assets are
// updated on command by the dev-publish tooling. Same electron-builder
// metadata shape, `-dev` file names so the stable listing (which filters on
// latest.yml / latest-linux.yml) can never pick them up by accident.
export const DEV_RELEASE_TAG = "dev-latest";
const DEV_WINDOWS_METADATA_FILE = "latest-dev.yml";
const DEV_LINUX_METADATA_FILE = "latest-linux-dev.yml";

export type UpdateChannel = "stable" | "dev";

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

/**
 * Per-platform dev metadata asset on the rolling `dev-latest` release;
 * null when the platform has no self-update path at all (deb, macOS).
 */
export function devMetadataFileName(platform: string, env: Record<string, string | undefined>): string | null {
    const mode = detectUpdateMode(platform, env);
    if (mode === "windows-installer") return DEV_WINDOWS_METADATA_FILE;
    if (mode === "linux-appimage") return DEV_LINUX_METADATA_FILE;
    return null;
}

/** Direct-asset URL on the dev-latest tag: no api.github.com listing needed. */
export function devMetadataDownloadUrl(feed: UpdateFeed, metadataFile: string): string {
    return `https://github.com/${feed.owner}/${feed.repo}/releases/download/${DEV_RELEASE_TAG}/${metadataFile}`;
}

export function devAssetDownloadUrl(feed: UpdateFeed, assetName: string): string {
    return `https://github.com/${feed.owner}/${feed.repo}/releases/download/${DEV_RELEASE_TAG}/${encodeURIComponent(assetName)}`;
}

/**
 * Channel preference, opt-in, default stable. Lives in userData so a deb
 * install (where the channel does nothing) is never surprised by it, and a
 * corrupt or absent file always means stable.
 */
function channelPrefsPath(): string {
    return path.join(app.getPath("userData"), "plotina-update-channel.json");
}

export function readUpdateChannel(): UpdateChannel {
    try {
        const raw = JSON.parse(fsSync.readFileSync(channelPrefsPath(), "utf8")) as { channel?: unknown };
        return raw?.channel === "dev" ? "dev" : "stable";
    } catch {
        return "stable";
    }
}

function writeUpdateChannel(channel: UpdateChannel): void {
    try {
        fsSync.mkdirSync(path.dirname(channelPrefsPath()), { recursive: true });
        fsSync.writeFileSync(channelPrefsPath(), JSON.stringify({ channel }));
    } catch (e) {
        console.warn("Plotina updater: cannot persist the update channel", e);
    }
}

/** Our dev builds end `-dev.<N>` (e.g. 4.12.8-plotina.6-dev.1). */
export function isDevVersion(version: string): boolean {
    return /[-~]dev\.\d/.test(version);
}

/**
 * Whether a feed candidate may be installed over the running version.
 * Normally strictly-newer only; the user-confirmed "return to stable"
 * (allowDowngrade) additionally accepts a reduction, but never the version
 * the user already runs.
 */
export function acceptCandidate(candidate: string, current: string, allowDowngrade: boolean): boolean {
    if (candidate === current) return false;
    if (allowDowngrade) return true;
    return isVersionNewer(candidate, current);
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
    /** Published artifact size in bytes, when the metadata carries it. */
    size: number | null;
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
    // top-level (column-0) size, when present: a cheap second gate next to
    // the digest so truncated or padded downloads are refused explicitly.
    const sizeRaw = grab(/^size:\s*(\d+)$/m);
    if (!version || !fileName || !sha512) return null;
    const size = sizeRaw === null || sizeRaw === "" ? null : Number(sizeRaw);
    return { version, fileName, sha512, releaseDate: releaseDate ?? "", size: Number.isFinite(size) ? size : null };
}

function sendUpdateStatus(status: boolean | string): void {
    global.mainWindow?.webContents.send("check_updates", status);
}

function sendUpdateDownloaded(update: ICachedUpdate): void {
    global.mainWindow?.webContents.send("update-downloaded", update);
}

export async function checkForUpdates(manual: boolean, opts: { allowDowngrade?: boolean } = {}): Promise<void> {
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
        // A version reduction is only ever honoured for the explicit,
        // user-confirmed "return to stable" from a dev build.
        const allowDowngrade = opts.allowDowngrade === true && isDevVersion(app.getVersion());
        const channel = readUpdateChannel();
        if (channel === "dev") {
            await checkDevFeed(feed, allowDowngrade, manual);
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
            .filter((r) => !r.draft && !r.prerelease
                && isDesktopReleaseTag(r.tag_name)
                && r.assets.some((a) => a.name === metadataFile))
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
            // Belt and braces: even inside a Desktop-tagged release, never
            // accept another product's artifact.
            if (!yml.fileName.startsWith("Plotina-Desktop")) continue;
            if (!acceptCandidate(yml.version, app.getVersion(), allowDowngrade)) continue;
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

/**
 * Dev channel: read the electron-builder metadata asset directly off the
 * rolling `dev-latest` release (no api.github.com listing, so the 60 req/h
 * budget stays with the stable checks) and run it through the exact same
 * download + verify + install path as stable. Dev versions carry a normal
 * semver `-dev.<M>` suffix and compare normally.
 */
async function checkDevFeed(feed: UpdateFeed, allowDowngrade: boolean, manual: boolean): Promise<void> {
    const devFile = devMetadataFileName(process.platform, process.env);
    if (!devFile) {
        // deb / otherwise non-self-updatable install: apt remains the path.
        if (manual) sendUpdateStatus(false);
        return;
    }
    const ymlRes = await fetch(devMetadataDownloadUrl(feed, devFile), {
        headers: { "User-Agent": `Plotina-Desktop/${app.getVersion()}` },
    });
    if (!ymlRes.ok) throw new Error(`Dev feed ${devFile} responded HTTP ${ymlRes.status}`);
    const yml = parseLatestYml(await ymlRes.text());
    if (!yml) throw new Error(`Dev feed ${devFile} is not parseable`);
    if (!acceptCandidate(yml.version, app.getVersion(), allowDowngrade)) {
        if (manual) sendUpdateStatus(false);
        return;
    }
    const release: Release = {
        tag_name: DEV_RELEASE_TAG,
        draft: false,
        prerelease: false,
        assets: [{ name: yml.fileName, browser_download_url: devAssetDownloadUrl(feed, yml.fileName) }],
    };
    sendUpdateStatus(true);
    if (UPDATE_MODE === "linux-appimage") {
        await downloadAndSwapAppImage(release, yml);
    } else {
        await downloadAndVerify(release, yml);
    }
}

/** Current channel, for the renderer (ipc.ts getUpdateChannel). */
export function getUpdateChannel(): UpdateChannel {
    return readUpdateChannel();
}

/**
 * Channel switch from Settings -> Help & About. Default is stable; the dev
 * choice is opt-in per user. `allowDowngrade` is the explicit "Вернуться на
 * стабильный" confirmation and only lets a dev build install an older stable
 * release (further gated in checkForUpdates on isDevVersion).
 * Returns the applied channel, or null for an invalid one. A channel switch
 * never installs anything on its own and never restarts the app: the
 * downloaded update lands in the normal "restart to update" flow.
 */
export function setUpdateChannel(rawChannel: string, allowDowngrade = false): UpdateChannel | null {
    if (rawChannel !== "stable" && rawChannel !== "dev") return null;
    const previous = readUpdateChannel();
    writeUpdateChannel(rawChannel);
    if (previous !== rawChannel) {
        // The pending download belongs to the channel it came from: forget it.
        pendingUpdate = null;
        lastNotifiedVersion = null;
        lastNotifiedKey = null;
        console.log(`Plotina updater: update channel ${previous} -> ${rawChannel}`);
    }
    void checkForUpdates(true, { allowDowngrade: rawChannel === "stable" && allowDowngrade === true });
    return rawChannel;
}

async function downloadAndVerify(release: Release, yml: LatestYml): Promise<void> {
    const installerAsset = release.assets.find((a) => a.name === yml.fileName);
    if (!installerAsset) {
        throw new Error(`Release ${release.tag_name} has no asset named ${yml.fileName}`);
    }
    const dir = path.join(app.getPath("userData"), "plotina-updates");
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, installerAsset.name);

    if ((await matchesSha512(dest, yml.sha512)) && (await matchesSize(dest, yml.size))) {
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
        if (!(await matchesSize(dest, yml.size))) {
            await fs.rm(dest, { force: true });
            throw new Error(`size mismatch for ${yml.fileName}; refusing to install`);
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

/**
 * Test-only: clear the module-level "already downloaded/notified" state so
 * each test case starts like a fresh app launch. Production code never calls
 * it; the same fields are reset on a channel switch in setUpdateChannel.
 */
export function _resetUpdateStateForTests(): void {
    pendingUpdate = null;
    lastNotifiedVersion = null;
    lastNotifiedKey = null;
}

/** Second, cheap gate next to the digest: the byte count the metadata claims. */
async function matchesSize(file: string, expected: number | null): Promise<boolean> {
    if (expected === null || !Number.isFinite(expected) || expected <= 0) return true;
    try {
        return (await fs.stat(file)).size === expected;
    } catch {
        return false;
    }
}

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
export async function stageAppImage(
    downloadUrl: string,
    currentPath: string,
    expectedSha512: string,
    assetName: string,
    expectedSize: number | null = null,
): Promise<string> {
    const dir = path.dirname(currentPath);
    const stagingDir = isDirWritable(dir) ? dir : path.join(app.getPath("userData"), "plotina-updates");
    await fs.mkdir(stagingDir, { recursive: true });
    const staged = path.join(stagingDir, `${assetName}.plotina-new`);
    const part = `${staged}.part`;
    await fs.rm(part, { force: true }); // never reuse a half-written temp file

    if ((await matchesSha512(staged, expectedSha512)) && (await matchesSize(staged, expectedSize))) {
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
    if (!(await matchesSize(part, expectedSize))) {
        await fs.rm(part, { force: true });
        throw new Error(`size mismatch for ${assetName}; the running AppImage was left untouched`);
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
    const staged = await stageAppImage(asset.browser_download_url, currentPath, yml.sha512, yml.fileName, yml.size);
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
    const channel = readUpdateChannel();
    console.log(
        `Plotina updater: channel=${channel}, checking ${feed.owner}/${feed.repo} ` +
            `${channel === "dev" ? `dev-latest (${devMetadataFileName(process.platform, process.env)})` : `releases (${metadataFile})`} ` +
            `for a newer version than ${app.getVersion()}`,
    );
    setTimeout(() => void checkForUpdates(false), INITIAL_UPDATE_DELAY_MS);
    setInterval(() => void checkForUpdates(false), UPDATE_POLL_INTERVAL_MS);
}
