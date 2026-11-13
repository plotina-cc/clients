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
  1. Reads resources/app-update.yml — the same file CI asserts on — as the
     go/no-go gate and for the GitHub publish target (provider/owner/repo)
     the dev feed derives from. The config.json update_base_url merely flips
     the code path on in electron-main.ts; this updater ignores its value.
  2. Stable channel: fetches the electron-builder metadata DIRECTLY from our
     edge — https://plotina.cc/dl/latest-linux.yml (Linux AppImage) or
     https://plotina.cc/dl/latest.yml (Windows NSIS). Those names mirror the
     metadata assets of the newest stable Desktop release verbatim (infra
     scripts/pull-release.py); no api.github.com listing is involved.
  3. Downloads the stable alias artifact next to that metadata —
     https://plotina.cc/dl/Plotina-Desktop.AppImage (alias of the versioned
     AppImage the yml names, byte-identical) or
     https://plotina.cc/dl/Plotina-Desktop-setup.exe — and verifies the
     SHA-512 digest and the byte size it publishes.
  4. Windows: runs the installer with `/S --updated --force-run` and quits —
     `--force-run` is what makes the silent NSIS install relaunch the app
     (see installUpdate: electron-builder's templates only start the app
     after a silent install when that flag is present).
     Linux (AppImage runtime, process.env.APPIMAGE set): the verified image is
     written next to the running one, chmod +x, then swapped in with an atomic
     rename over the current AppImage (POSIX rename is legal while the old
     file is still open by the FUSE mount: the running process keeps the old
     inode, the directory entry gets the new bytes). "Restart" hands a detached
     shell helper the same path; it waits until this process has really exited
     (the single-instance lock dies with it) and only then execs the image.
     If the directory is not writable
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
  authenticity rests on (a) TLS to plotina.cc — our own edge, whose /dl files
  are pulled from the GitHub release by infra scripts/pull-release.py — and
  (b) the sha512+size in the direct metadata, which stops corruption and
  casual tampering but NOT an edge-host compromise or a GitHub repo write /
  account compromise — whoever controls /dl content or can publish a release
  can push any binary this updater will run as the user. A signed
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
  - stable: the direct electron-builder metadata on our edge —
    https://plotina.cc/dl/latest-linux.yml (Linux AppImage) /
    https://plotina.cc/dl/latest.yml (Windows NSIS) — one GET, artifact from
    the stable alias on the same path (/dl/Plotina-Desktop.AppImage /
    /dl/Plotina-Desktop-setup.exe), strictly-newer only. No api.github.com
    listing, no anonymous rate limit.
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

const UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // our own edge: stay polite, a check is one small GET
const INITIAL_UPDATE_DELAY_MS = 30 * 1000;
// electron-builder's per-platform metadata asset, mirrored verbatim to /dl.
const WINDOWS_METADATA_FILE = "latest.yml";
const LINUX_METADATA_FILE = "latest-linux.yml";
// Direct feed on our edge (infra scripts/pull-release.py mirrors the newest
// stable release's metadata + stable artifact aliases under exactly these
// names). The stable path never touches api.github.com.
export const PLOTINA_DL_BASE = "https://plotina.cc/dl";
export const STABLE_APPIMAGE_ALIAS = "Plotina-Desktop.AppImage";
export const STABLE_NSIS_ALIAS = "Plotina-Desktop-setup.exe";
// This repository hosts every client; a release is only a Desktop release if
// its tag carries the Desktop marker. The direct /dl feed is already
// Desktop-scoped by file name; the tag grammar stays exported as the single
// documented rule for Desktop tags (CI, tooling and tests assert on it).
// Without a filter like this, the Lite release (semver 4.12.8 > Desktop
// 1.12.32) was once picked as an "update" and its AppImage replaced Plotina
// Desktop — the Desktop -> Lite downgrade seen in the wild.
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
// GitHub's release-asset CDN intermittently answers 504 for the small YAML
// assets while the AppImage still downloads. Keep a mirrored copy on our edge
// as a 5xx-only fallback: the metadata is rewritten with absolute GitHub asset
// URLs there, so the artifact still comes from the release.
const DEV_FEED_FALLBACK_BASE = "https://plotina.cc/dl/dev/desktop";

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

export function devMetadataFallbackUrl(metadataFile: string): string {
    return `${DEV_FEED_FALLBACK_BASE}/${encodeURIComponent(metadataFile)}`;
}

/**
 * Stable channel: electron-builder metadata file for this install, mirrored on
 * our edge. null when the platform has no self-update path (deb, macOS).
 */
export function stableMetadataFileName(platform: string, env: Record<string, string | undefined>): string | null {
    const mode = detectUpdateMode(platform, env);
    if (mode === "windows-installer") return WINDOWS_METADATA_FILE;
    if (mode === "linux-appimage") return LINUX_METADATA_FILE;
    return null;
}

/** Direct metadata URL on /dl: one GET replaces the whole GitHub listing. */
export function stableMetadataUrl(platform: string, env: Record<string, string | undefined>): string | null {
    const file = stableMetadataFileName(platform, env);
    return file ? `${PLOTINA_DL_BASE}/${file}` : null;
}

/**
 * Stable alias of the artifact on /dl. The yml's versioned fileName is NOT
 * used to build the URL: pull-release.py mirrors the newest release under
 * these fixed names, byte-identical to the versioned asset, so the yml's
 * sha512+size verify against exactly what /dl serves.
 */
export function stableArtifactUrl(platform: string, env: Record<string, string | undefined>): string | null {
    const mode = detectUpdateMode(platform, env);
    if (mode === "windows-installer") return `${PLOTINA_DL_BASE}/${STABLE_NSIS_ALIAS}`;
    if (mode === "linux-appimage") return `${PLOTINA_DL_BASE}/${STABLE_APPIMAGE_ALIAS}`;
    return null;
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

/** True when both versions share the published Plotina base (same N), dev or not. */
function isSamePlotinaBase(candidate: string, current: string): boolean {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    return a.major === b.major && a.minor === b.minor && a.patch === b.patch && a.build === b.build;
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
    /** The url field as published; edge metadata uses an absolute URL. */
    url: string;
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

/** Numeric tokens of a non-Plotina version (legacy fallback). */
function versionNumbers(version: string): number[] {
    return version
        .split(/[.\-+_]/)
        .filter((part) => /^\d+$/.test(part))
        .map(Number);
}

interface PlotinaVersion {
    major: number;
    minor: number;
    patch: number;
    build: number;
    /** null = stable release; number = -dev.N prerelease. */
    dev: number | null;
}

function parseVersion(version: string): PlotinaVersion | null {
    // Plotina desktop versions are semver-like: 1.12.32-plotina.42 and
    // 1.12.32-plotina.42-dev.1. Stable is the release, dev is its prerelease:
    // the stable .42 must be NEWER than .42-dev.1. The old numeric-token
    // comparator treated the dev suffix as an extra higher token (a mobile
    // versionCode carry-over) and forced a downgrade confirmation.
    const m = /^(\d+)\.(\d+)\.(\d+)-plotina\.(\d+)(?:-dev\.(\d+))?(?:\.local)?$/.exec(
        version.trim(),
    );
    if (!m) return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        build: Number(m[4]),
        dev: m[5] === undefined ? null : Number(m[5]),
    };
}

export function isVersionNewer(candidate: string, current: string): boolean {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (a && b) {
        for (const key of ["major", "minor", "patch", "build"] as const) {
            if (a[key] !== b[key]) return a[key] > b[key];
        }
        // Same Plotina build: a stable release outranks its dev prerelease.
        if (a.dev === null && b.dev !== null) return true;
        if (a.dev !== null && b.dev === null) return false;
        if (a.dev !== null && b.dev !== null) return a.dev > b.dev;
        return false;
    }
    const x = versionNumbers(candidate);
    const y = versionNumbers(current);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
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
    // first `url:` entry of the files list; edge metadata publishes an
    // absolute URL there, while GitHub metadata uses a bare asset name.
    const fileUrl = grab(/^files:[\s\S]*?-\s*url:\s*(.+)$/m);
    const fileName = fileUrl
        ? decodeURIComponent(fileUrl.split("/").pop() || "")
        : null;
    // top-level (column-0) sha512 covers the installer itself
    const sha512 = grab(/^sha512:\s*(.+)$/m);
    const releaseDate = grab(/^releaseDate:\s*(.+)$/m);
    // top-level (column-0) size, when present: a cheap second gate next to
    // the digest so truncated or padded downloads are refused explicitly.
    const sizeRaw = grab(/^size:\s*(\d+)$/m);
    let size = sizeRaw === null || sizeRaw === "" ? null : Number(sizeRaw);
    if (size === null) {
        // electron-builder writes the size ONLY per files entry in
        // latest-linux.yml (the top level has sha512+path but no size). Take
        // the size of the first entry — the same one `fileName` came from.
        const firstBlock = text.split(/\n(?=\s*-\s*url:)/).find((b) => /^\s*-\s*url:/.test(b));
        const entrySize = firstBlock ? /^ {2,}size:\s*(\d+)/m.exec(firstBlock) : null;
        if (entrySize) size = Number(entrySize[1]);
    }
    if (!version || !fileUrl || !fileName || !sha512) return null;
    return { version, fileName, url: fileUrl, sha512, releaseDate: releaseDate ?? "", size: Number.isFinite(size) ? size : null };
}

function sendUpdateStatus(status: boolean | string): void {
    global.mainWindow?.webContents.send("check_updates", status);
}

function sendUpdateDownloaded(update: ICachedUpdate): void {
    global.mainWindow?.webContents.send("update-downloaded", update);
}

export async function checkForUpdates(
    manual: boolean,
    opts: { allowDowngrade?: boolean; channelSwitch?: boolean } = {},
): Promise<void> {
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
    if (checking) {
        // A manual click can land while the boot-time automatic check is
        // already waiting on the dev feed. Returning silently leaves the
        // renderer on «Проверяю…» until its 60 s timeout; acknowledge the
        // collision and let the in-flight check's terminal status update it.
        if (manual) sendUpdateStatus("Проверка уже выполняется. Дождитесь результата.");
        return;
    }
    checking = true;
    try {
        if (pendingUpdate) {
            // Upstream does the same: a downloaded update is re-shown rather than re-fetched.
            sendUpdateDownloaded(pendingUpdate);
            return;
        }
        // A version reduction is only ever honoured for the explicit,
        // user-confirmed "return to stable" from a dev build.
        const allowDowngrade = opts.allowDowngrade === true && isDevVersion(app.getVersion());
        // A user switching channels may move to the dev prerelease of the
        // SAME build (stable .42 -> .42-dev.2). Semver ranks the stable release
        // above its prerelease, so that is only allowed on the explicit switch
        // and only within one build; an older build still needs the explicit
        // "return to stable" confirmation.
        const channelSwitch = opts.channelSwitch === true;
        const currentBuild = parseVersion(app.getVersion())?.build;
        const channel = readUpdateChannel();
        if (channel === "dev") {
            await checkDevFeed(feed, allowDowngrade, manual);
            return;
        }
        // Stable: one direct GET of the electron-builder metadata on our edge.
        // No api.github.com release listing — /dl/latest[-linux].yml always
        // describes exactly the newest stable Desktop release (pull-release.py
        // mirrors it from the tag picked by the Desktop marker).
        const metaUrl = stableMetadataUrl(process.platform, process.env);
        const artifactUrl = stableArtifactUrl(process.platform, process.env);
        if (!metaUrl || !artifactUrl) {
            // deb/macOS/unknown: no self-update path (guarded above; belt and braces).
            if (manual) sendUpdateStatus(false);
            return;
        }
        const res = await fetch(metaUrl, {
            headers: { "User-Agent": `Plotina-Desktop/${app.getVersion()}` },
        });
        if (!res.ok) throw new Error(`Stable feed ${metaUrl} responded HTTP ${res.status}`);
        const yml = parseLatestYml(await res.text());
        if (!yml) throw new Error(`Stable feed ${metaUrl} is not parseable`);
        // Belt and braces: even inside a Desktop-scoped feed name, never
        // accept another product's artifact.
        if (!yml.fileName.startsWith("Plotina-Desktop")) {
            throw new Error(`Stable feed ${metaUrl} names ${yml.fileName}, which is not a Plotina Desktop artifact`);
        }
        const candidateBuild = parseVersion(yml.version)?.build;
        const sameBuildSwitch =
            channelSwitch && currentBuild !== undefined && candidateBuild === currentBuild;
        if (!acceptCandidate(yml.version, app.getVersion(), allowDowngrade || sameBuildSwitch)) {
            if (manual) sendUpdateStatus(false);
            return;
        }
        const release: Release = {
            tag_name: "dl-stable",
            draft: false,
            prerelease: false,
            assets: [{ name: yml.fileName, browser_download_url: artifactUrl }],
        };
        sendUpdateStatus(true); // "update-available" equivalent
        if (UPDATE_MODE === "linux-appimage") {
            await downloadAndSwapAppImage(release, yml);
        } else {
            await downloadAndVerify(release, yml);
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
 * rolling `dev-latest` release (direct asset download, no API listing — the
 * same no-API rule the stable /dl path follows) and run it through the exact
 * same download + verify + install path as stable. Dev versions carry a normal
 * semver `-dev.<M>` suffix and compare normally.
 */
async function checkDevFeed(feed: UpdateFeed, allowDowngrade: boolean, manual: boolean): Promise<void> {
    const devFile = devMetadataFileName(process.platform, process.env);
    if (!devFile) {
        // deb / otherwise non-self-updatable install: apt remains the path.
        if (manual) sendUpdateStatus(false);
        return;
    }
    // The edge mirror is the source of truth for local/dev builds: it is
    // updated by the publish job even when the GitHub asset CDN is stale or
    // still points at the previous dev release. GitHub remains a fallback for
    // an edge mirror that is temporarily unavailable.
    let ymlRes = await fetch(devMetadataFallbackUrl(devFile), {
        headers: { "User-Agent": `Plotina-Desktop/${app.getVersion()}` },
    });
    let metadataSource = "edge";
    if (!ymlRes.ok) {
        console.warn(`Plotina updater: edge dev feed HTTP ${ymlRes.status}; trying GitHub dev-latest`);
        metadataSource = "github";
        ymlRes = await fetch(devMetadataDownloadUrl(feed, devFile), {
            headers: { "User-Agent": `Plotina-Desktop/${app.getVersion()}` },
        });
    }
    if (!ymlRes.ok) throw new Error(`Dev feed ${devFile} responded HTTP ${ymlRes.status}`);
    const yml = parseLatestYml(await ymlRes.text());
    if (!yml) throw new Error(`Dev feed ${devFile} is not parseable`);
    // Same-base channel permission, the dev-channel counterpart of the stable
    // branch's sameBuildSwitch: semver ranks the stable release ABOVE its own
    // dev prerelease, so acceptCandidate alone refuses .N-dev.M when the app
    // stands on the published stable .N — yet that is exactly the step the
    // dev channel exists for (the channel choice is the user's explicit opt-in,
    // so no extra channelSwitch flag is required). The permission is scoped to
    // one base and to the stable -> dev direction only: another base is still
    // compared normally (.48-dev.1 over .49 stays refused), and a dev build
    // never walks back inside its own base (.49-dev.2 over .49-dev.3 stays
    // refused). allowDowngrade is untouched.
    const sameBuildDev =
        !isDevVersion(app.getVersion()) &&
        isDevVersion(yml.version) &&
        isSamePlotinaBase(yml.version, app.getVersion());
    if (!acceptCandidate(yml.version, app.getVersion(), allowDowngrade || sameBuildDev)) {
        if (manual) sendUpdateStatus(false);
        return;
    }
    const artifactUrl = /^https?:\/\//i.test(yml.url)
        ? yml.url
        : devAssetDownloadUrl(feed, yml.fileName);
    console.log(`Plotina updater: using ${metadataSource} dev metadata for ${yml.version}`);
    const release: Release = {
        tag_name: DEV_RELEASE_TAG,
        draft: false,
        prerelease: false,
        assets: [{ name: yml.fileName, browser_download_url: artifactUrl }],
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
    void checkForUpdates(true, {
        allowDowngrade: rawChannel === "stable" && allowDowngrade === true,
        channelSwitch: previous !== rawChannel,
    });
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
        // The swap already happened; "install" relaunches the same path, which
        // now holds the new image. But we must NOT spawn it while this process
        // is still alive: app.quit() is asynchronous (before-quit handlers,
        // window teardown, Sentry/store flushes all run first), and the single
        // instance lock is held until the old main process actually exits.
        // electron-main.ts answers a lock-less start with
        // `Other instance detected: exiting` + app.exit() — so a direct spawn
        // here reliably dies against our own lock, we then quit, and the user
        // is left with NO running app ("restart" became shutdown; regression
        // seen on .44 -> .45 updates).
        //
        // Instead hand the relaunch to a detached shell helper that waits for
        // this PID to disappear (and never come back as an unreaped zombie) and
        // only then execs the AppImage. The wait is capped at ~30s so a hung
        // shutdown cannot suppress the restart forever: after the cap it
        // launches anyway, which at worst re-creates the old race, never
        // "nothing". No args: a plain start, like the NSIS runAfterFinish
        // relaunch on Windows.
        const target = resolveCurrentAppImage();
        const helper =
            'old="$1"; target="$2"; i=0\n' +
            "while kill -0 \"$old\" 2>/dev/null; do\n" +
            '  st=$(ps -o state= -p "$old" 2>/dev/null)\n' +
            '  case "$st" in ""|*Z*) break;; esac\n' +
            "  i=$((i+1)); [ \"$i\" -ge 300 ] && break; sleep 0.1\n" +
            "done\n" +
            'exec "$target"';
        const child = spawnImpl("/bin/sh", ["-c", helper, "plotina-update-restart", String(process.pid), target], {
            detached: true,
            stdio: "ignore",
        });
        child.on("error", (e) => console.error("Plotina updater: failed to start the restart helper", e));
        child.unref();
        app.quit();
        return;
    }
    // /S = silent NSIS, --updated = "this is an update, not a first install",
    // --force-run = start the app after the install.
    // Read against electron-builder 26.16.1's own templates (the version that
    // builds our installers): installSection.nsh (ONE_CLICK branch) launches
    // the app after install only when the installer is NOT silent or the
    // command line carries --force-run; --updated alone does NOT relaunch —
    // it only keeps shortcuts/user data. Without --force-run, the silent
    // installer force-kills the running app (allowOnlyOneInstallerInstance.nsh:
    // taskkill + wait-for-exit), installs, and quits — the app "just turns
    // off", the Windows half of this bug. electron-updater's own
    // quitAndInstall(silent, forceRunAfter) passes --force-run for exactly
    // this reason.
    // The single-instance lock is not a problem here, unlike the old direct
    // relaunch on Linux: the installer kills and waits for the old process
    // BEFORE it ever reaches StartApp (and file locks alone enforce that), so
    // the relaunched app always starts against a free lock.
    const child = spawnImpl(pendingUpdate.installerPath, ["/S", "--updated", "--force-run"], {
        detached: true,
        stdio: "ignore",
    });
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
    const channel = readUpdateChannel();
    const where = channel === "dev"
        ? `GitHub ${feed.owner}/${feed.repo} dev-latest (${devMetadataFileName(process.platform, process.env)})`
        : stableMetadataUrl(process.platform, process.env);
    console.log(
        `Plotina updater: channel=${channel}, checking ${where} for a newer version than ${app.getVersion()}`,
    );
    setTimeout(() => void checkForUpdates(false), INITIAL_UPDATE_DELAY_MS);
    setInterval(() => void checkForUpdates(false), UPDATE_POLL_INTERVAL_MS);
}
