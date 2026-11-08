// Dev-update-channel tests for ../updater.ts (Settings -> Help & About
// "Канал обновлений: Стабильный / Dev").
//
//   node --test element-desktop/desktop/tests/update-channel.test.mjs
//
// Same harness as linux-updater.test.mjs: "electron" maps to electron-stub.mjs,
// ../updater.ts is imported through Node >= 22 type-stripping, and every fetch
// is served by a local route stub — the dev feed tag `dev-latest` does not
// exist yet and must never be assumed live. UPDATE_MODE is decided at import,
// so process.env.APPIMAGE is set BEFORE the import (AppImage path exercises
// both channels; the Windows path is covered through the pure helpers).
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { state } from "./electron-stub.mjs";

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "electron") {
            return { url: import.meta.resolve("./electron-stub.mjs"), shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "plotina-channel-test-"));

const sha512B64 = (buf) => createHash("sha512").update(buf).digest("base64");

// --- scratch layout -------------------------------------------------------
async function makeLayout() {
    const root = await fs.mkdtemp(path.join(TMP, "case-"));
    const appDir = path.join(root, "apps");
    const userData = path.join(root, "user-data");
    const downloads = path.join(root, "Downloads");
    const resources = path.join(root, "resources");
    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(resources, { recursive: true });
    const current = path.join(appDir, "Plotina-Desktop-1.12.32-plotina.8.AppImage");
    await fs.writeFile(current, "OLD-IMAGE-CONTENT");
    await fs.chmod(current, 0o755);
    await fs.writeFile(
        path.join(resources, "app-update.yml"),
        "provider: github\nowner: plotina-cc\nrepo: clients\n",
    );
    return { root, appDir, userData, downloads, resources, current };
}

function resetStubs(layout) {
    state.version = "1.12.32-plotina.8";
    state.isPackaged = true;
    state.paths = { userData: layout.userData, downloads: layout.downloads, home: layout.root };
    state.dialogs = [];
    state.dialogResponse = 1; // "Later": a check must never restart by itself
    state.quitCount = 0;
    state.sent = [];
    state.ipcHandlers = {};
    globalThis.mainWindow = { webContents: { send: (channel, payload) => state.sent.push({ channel, payload }) } };
    process.resourcesPath = layout.resources;
    process.env.APPIMAGE = layout.current; // re-read per call by the AppImage path
    // Fresh app launch: no leftover pending download from a previous case.
    updater._resetUpdateStateForTests();
}

// --- fetch route stub -------------------------------------------------------
// routes: [{ has: substring -> responder(url) -> Response-like }]
function stubFetch(routes) {
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        for (const r of routes) {
            if (u.includes(r.has)) return r.respond(u);
        }
        return new Response("unstubbed: " + u, { status: 404 });
    };
    return { calls, restore: () => (globalThis.fetch = real) };
}

const ymlResponse = (text) => new Response(text, { status: 200 });
const json = (obj) => new Response(JSON.stringify(obj), { status: 200 });

// Serve bytes through a real HTTP URL is unnecessary here: every fetch goes
// through the route stub, so release payloads are plain Response bodies.

/** electron-builder's metadata shape: files list first, top-level sha512/size. */
function builderYml({ version, fileName, sha512, size, releaseDate = "2026-11-05T12:00:00.000Z" }) {
    return [
        `version: ${version}`,
        "files:",
        `  - url: ${fileName}`,
        `    sha512: ${sha512}`,
        `    size: ${size}`,
        `path: ${fileName}`,
        `sha512: ${sha512}`,
        `size: ${size}`,
        `releaseDate: '${releaseDate}'`,
        "",
    ].join("\n");
}

const firstLayout = await makeLayout();
process.env.APPIMAGE = firstLayout.current; // UPDATE_MODE = linux-appimage at import
const updater = await import("../updater.ts");
await fs.rm(firstLayout.current, { force: true });

// =========================================================================
// 1. Channel URL selection
// =========================================================================

test("devMetadataFileName picks the per-platform dev metadata asset", () => {
    assert.equal(updater.devMetadataFileName("win32", {}), "latest-dev.yml");
    assert.equal(updater.devMetadataFileName("linux", { APPIMAGE: "/x/Plotina.AppImage" }), "latest-linux-dev.yml");
    assert.equal(updater.devMetadataFileName("linux", {}), null, "deb installs have no dev self-update path");
    assert.equal(updater.devMetadataFileName("darwin", {}), null);
    assert.equal(updater.devMetadataFileName("freebsd", {}), null);
});

test("devMetadataDownloadUrl is the approved dev-latest feed location", () => {
    const feed = { owner: "plotina-cc", repo: "clients" };
    assert.equal(
        updater.devMetadataDownloadUrl(feed, "latest-dev.yml"),
        "https://github.com/plotina-cc/clients/releases/download/dev-latest/latest-dev.yml",
    );
    assert.equal(
        updater.devMetadataDownloadUrl(feed, "latest-linux-dev.yml"),
        "https://github.com/plotina-cc/clients/releases/download/dev-latest/latest-linux-dev.yml",
    );
});

test("devAssetDownloadUrl builds the installer URL on the same tag", () => {
    const feed = { owner: "plotina-cc", repo: "clients" };
    assert.equal(
        updater.devAssetDownloadUrl(feed, "Plotina-Desktop-4.12.8-plotina.6-dev.1-setup.exe"),
        "https://github.com/plotina-cc/clients/releases/download/dev-latest/Plotina-Desktop-4.12.8-plotina.6-dev.1-setup.exe",
    );
    assert.match(updater.devAssetDownloadUrl(feed, "a b.AppImage"), /a%20b\.AppImage$/, "asset names are URL-encoded");
});

test("the stable feed is unchanged", () => {
    assert.equal(updater.PLOTINA_RELEASES_FEED, "https://github.com/plotina-cc/clients/releases");
    assert.equal(updater.DEV_RELEASE_TAG, "dev-latest");
});

// =========================================================================
// 2. Dev version parsing/comparison — normal semver logic, no versionCode hack
// =========================================================================

test("isVersionNewer compares dev builds normally", () => {
    assert.equal(updater.isVersionNewer("4.12.8-plotina.6-dev.2", "4.12.8-plotina.6-dev.1"), true);
    assert.equal(updater.isVersionNewer("4.12.8-plotina.6-dev.1", "4.12.8-plotina.6-dev.2"), false);
    assert.equal(updater.isVersionNewer("4.12.8-plotina.6-dev.1", "4.12.8-plotina.5"), true, "newer plotina build beats older stable");
    assert.equal(updater.isVersionNewer("4.12.8-plotina.4-dev.9", "4.12.8-plotina.5"), false, "older build line is not newer");
    assert.equal(updater.isVersionNewer("4.12.8-plotina.6-dev.1", "4.12.8-plotina.6-dev.1"), false);
    assert.equal(updater.isVersionNewer("4.12.9-plotina.1-dev.1", "4.12.8-plotina.99"), true);
    // A stable release of the same Plotina build is newer than its dev
    // prerelease. This is desktop semver, not Android's versionCode ordering.
    assert.equal(updater.isVersionNewer("4.12.8-plotina.6", "4.12.8-plotina.6-dev.1"), true);
    assert.equal(updater.isVersionNewer("4.12.8-plotina.6-dev.2", "4.12.8-plotina.6"), false);
    assert.equal(updater.isVersionNewer("4.12.8-plotina.6-dev.2", "4.12.8-plotina.6-dev.1"), true);
});

test("isDevVersion recognises the dev build suffix", () => {
    assert.equal(updater.isDevVersion("4.12.8-plotina.6-dev.1"), true);
    assert.equal(updater.isDevVersion("1.12.32-plotina.9-dev.2"), true);
    assert.equal(updater.isDevVersion("1.12.32-plotina.9"), false);
    assert.equal(updater.isDevVersion("1.12.32"), false);
});

test("acceptCandidate implements stable/return gating", () => {
    assert.equal(updater.acceptCandidate("4.12.8-plotina.6", "4.12.8-plotina.5", false), true, "newer is accepted");
    assert.equal(updater.acceptCandidate("4.12.8-plotina.5", "4.12.8-plotina.5", false), false, "equal is not");
    assert.equal(updater.acceptCandidate("4.12.8-plotina.5", "4.12.8-plotina.5", true), false, "even on return, same version installs nothing");
    assert.equal(updater.acceptCandidate("4.12.8-plotina.4", "4.12.8-plotina.5", false), false, "downgrades are refused normally");
    assert.equal(updater.acceptCandidate("4.12.8-plotina.4", "4.12.8-plotina.5", true), true, "the confirmed return accepts a reduction");
    assert.equal(updater.acceptCandidate("4.12.8-plotina.6", "4.12.8-plotina.6-dev.1", false), true, "stable release outranks same-build dev without downgrade confirmation");
});

test("parseLatestYml parses a Windows dev metadata file", () => {
    const text = builderYml({
        version: "4.12.8-plotina.6-dev.1",
        fileName: "Plotina-Desktop-4.12.8-plotina.6-dev.1-setup.exe",
        sha512: "ZZZdevdigest==",
        size: 104857600,
    });
    const yml = updater.parseLatestYml(text);
    assert.ok(yml);
    assert.equal(yml.version, "4.12.8-plotina.6-dev.1");
    assert.equal(yml.fileName, "Plotina-Desktop-4.12.8-plotina.6-dev.1-setup.exe");
    assert.equal(yml.sha512, "ZZZdevdigest==");
    assert.equal(yml.size, 104857600);
    assert.equal(yml.releaseDate, "2026-11-05T12:00:00.000Z");
});

test("parseLatestYml tolerates metadata without a size", () => {
    const yml = updater.parseLatestYml("version: 1.0.0-dev.1\nfiles:\n  - url: a.exe\nsha512: abc\n");
    assert.ok(yml);
    assert.equal(yml.size, null);
});

// =========================================================================
// 3. Channel preference persistence
// =========================================================================

test("channel defaults to stable and survives a corrupt prefs file", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const stub = stubFetch([]);
    try {
        assert.equal(updater.getUpdateChannel(), "stable", "missing prefs file = stable");
        await fs.writeFile(path.join(layout.userData, "plotina-update-channel.json"), "{not json");
        assert.equal(updater.getUpdateChannel(), "stable", "broken prefs file falls back to stable");
    } finally {
        stub.restore();
    }
});

test("setUpdateChannel validates, persists, and re-checks against the dev feed", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const stub = stubFetch([{ has: "dev-latest/latest-linux-dev.yml", respond: () => new Response("nope", { status: 404 }) }]);
    try {
        assert.equal(updater.setUpdateChannel("nightly"), null, "unknown channels are refused");
        assert.equal(updater.getUpdateChannel(), "stable");
        assert.equal(updater.setUpdateChannel("dev"), "dev");
        assert.equal(updater.getUpdateChannel(), "dev");
        const prefs = JSON.parse(await fs.readFile(path.join(layout.userData, "plotina-update-channel.json"), "utf8"));
        assert.equal(prefs.channel, "dev");
        // the channel switch kicked a manual check that asked the DEV feed...
        await new Promise((r) => setTimeout(r, 50));
        assert.ok(stub.calls.some((u) => u.includes("dev-latest/latest-linux-dev.yml")), stub.calls.join("\n"));
        // ...and never listed releases through the GitHub API (dev path is a
        // single direct asset, no api.github.com budget spent).
        assert.ok(!stub.calls.some((u) => u.includes("api.github.com")), "dev checks must not list releases");
        // a 404 on a manual check reports the error through check_updates
        assert.ok(state.sent.some((s) => s.channel === "check_updates" && typeof s.payload === "string"));
    } finally {
        stub.restore();
    }
});

// =========================================================================
// 4. Dev channel check: feed, gate, download, verify, swap (AppImage path)
// =========================================================================

test("dev channel installs the dev-latest AppImage", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const payload = Buffer.from("DEV-APPIMAGE-BYTES".repeat(4096)); // ~74 KB
    const sha = sha512B64(payload);
    const fileName = "Plotina-Desktop-1.12.32-plotina.9-dev.1.AppImage";
    const ymlText = builderYml({ version: "1.12.32-plotina.9-dev.1", fileName, sha512: sha, size: payload.length });
    await fs.writeFile(path.join(layout.userData, "plotina-update-channel.json"), JSON.stringify({ channel: "dev" }));
    const calls = [];
    const stub = stubFetch([
        {
            has: "dev-latest/latest-linux-dev.yml",
            respond: (u) => {
                calls.push(u);
                return ymlResponse(ymlText);
            },
        },
        {
            // the asset URL the updater constructs for dev-latest
            has: `dev-latest/${fileName}`,
            respond: (u) => {
                calls.push(u);
                return new Response(Buffer.from(payload), { status: 200, headers: { "content-length": String(payload.length) } });
            },
        },
        {
            has: "api.github.com",
            respond: (u) => {
                calls.push(u);
                return json([]);
            },
        },
    ]);
    try {
        await updater.checkForUpdates(true);

        assert.ok(calls.some((u) => u.includes("dev-latest/latest-linux-dev.yml")), "dev feed queried");
        assert.ok(calls.some((u) => u.includes(`dev-latest/${fileName}`)), "dev asset downloaded from dev-latest tag");
        assert.ok(!calls.some((u) => u.includes("api.github.com")), "dev path is direct-asset, no release listing");

        const channels = state.sent.map((s) => s.channel);
        assert.ok(channels.includes("check_updates"), "renderer got check_updates");
        assert.ok(channels.includes("update-downloaded"), "renderer got update-downloaded");
        const dl = state.sent.find((s) => s.channel === "update-downloaded");
        assert.equal(dl.payload.releaseName, "1.12.32-plotina.9-dev.1");

        const swapped = await fs.readFile(layout.current);
        assert.equal(sha512B64(swapped), sha, "swapped-in image matches the dev sha512");
        assert.deepEqual(await fs.readdir(layout.appDir), [path.basename(layout.current)], "no leftovers next to the image");
        const dlg = state.dialogs.at(-1);
        assert.ok(dlg && dlg.buttons.includes("Restart now"), "restart prompt shown");
    } finally {
        stub.restore();
    }
});

test("dev channel refuses a same-version download", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    state.version = "1.12.32-plotina.9-dev.1";
    await fs.writeFile(path.join(layout.userData, "plotina-update-channel.json"), JSON.stringify({ channel: "dev" }));
    const ymlSame = builderYml({ version: "1.12.32-plotina.9-dev.1", fileName: "x.AppImage", sha512: "AAA==", size: 4 });
    const stub = stubFetch([{ has: "latest-linux-dev.yml", respond: () => ymlResponse(ymlSame) }]);
    try {
        await updater.checkForUpdates(true);
        assert.ok(state.sent.some((s) => s.channel === "check_updates" && s.payload === false), "same version -> no update");
        assert.equal(state.sent.filter((s) => s.channel === "update-downloaded").length, 0);
        assert.equal(await fs.readFile(layout.current, "utf8"), "OLD-IMAGE-CONTENT");
    } finally {
        stub.restore();
    }
});

test("a size mismatch is refused before install; the running image stays untouched", async () => {
    // AppImage mode: stageAppImage must reject before anything is renamed,
    // so the swap never sees wrong-sized bytes and nothing is left behind.
    const layout = await makeLayout();
    resetStubs(layout);
    state.version = "1.12.32-plotina.8";
    const payload = Buffer.from("TRUNCATED-LOOKALIKE".repeat(100));
    const sha = sha512B64(payload);
    const fileName = "Plotina-Desktop-1.12.32-plotina.9.AppImage";
    const ymlWrongSize = builderYml({ version: "1.12.32-plotina.9", fileName, sha512: sha, size: payload.length + 1 });
    const stub = stubFetch([
        { has: "plotina.cc/dl/latest-linux.yml", respond: () => ymlResponse(ymlWrongSize) },
        { has: "plotina.cc/dl/Plotina-Desktop.AppImage", respond: () => new Response(Buffer.from(payload), { status: 200, headers: { "content-length": String(payload.length) } }) },
        {
            has: "api.github.com",
            respond: (u) => {
                throw new Error(`stable path must never call the GitHub API (${u})`);
            },
        },
    ]);
    try {
        await updater.checkForUpdates(true); // AppImage mode rejects in stageAppImage
        assert.ok(stub.calls.some((u) => u === "https://plotina.cc/dl/latest-linux.yml"), "direct metadata fetched");
        assert.ok(stub.calls.some((u) => u === "https://plotina.cc/dl/Plotina-Desktop.AppImage"), "alias artifact fetched");
        assert.ok(!stub.calls.some((u) => u.includes("github.com")), `no GitHub at all: ${stub.calls}`);
        assert.equal(await fs.readFile(layout.current, "utf8"), "OLD-IMAGE-CONTENT", "running image untouched on size mismatch");
        assert.deepEqual(await fs.readdir(layout.appDir), [path.basename(layout.current)], "no partial file left beside the image");
        const updDir = path.join(layout.userData, "plotina-updates");
        const leftovers = await fs.readdir(updDir).catch(() => []);
        assert.equal(leftovers.filter((f) => f.endsWith(".part")).length, 0, "no .part leftovers");
        const err = state.sent.find((s) => s.channel === "check_updates" && typeof s.payload === "string");
        assert.ok(err && /size mismatch/.test(err.payload), `expected size-mismatch error, sent: ${JSON.stringify(state.sent)}`);
    } finally {
        stub.restore();
    }
});

// =========================================================================
// 5. Return to stable: normal logic by default, explicit reduction when confirmed
// =========================================================================

test("return to stable: normal check refuses the older stable release", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    state.version = "1.12.32-plotina.9-dev.1"; // user runs a dev build
    await fs.writeFile(path.join(layout.userData, "plotina-update-channel.json"), JSON.stringify({ channel: "dev" }));
    const stub = stableFeedStub(layout, "1.12.32-plotina.8", Buffer.from("STABLE"));
    try {
        updater.setUpdateChannel("stable"); // channel switch, NOT the confirmed return
        await new Promise((r) => setTimeout(r, 50));
        await updater.checkForUpdates(true);
        assert.ok(state.sent.some((s) => s.channel === "check_updates" && s.payload === false), "lower version refused");
        assert.equal(state.sent.filter((s) => s.channel === "update-downloaded").length, 0);
        assert.equal(await fs.readFile(layout.current, "utf8"), "OLD-IMAGE-CONTENT");
    } finally {
        stub.restore();
    }
});

test("confirmed return to stable installs the lower stable release", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    state.version = "1.12.32-plotina.9-dev.1"; // user runs a dev build
    const payload = Buffer.from("REAL-STABLE-IMAGE".repeat(4000));
    const stub = stableFeedStub(layout, "1.12.32-plotina.8", payload);
    try {
        const applied = updater.setUpdateChannel("stable", true);
        assert.equal(applied, "stable");
        await new Promise((r) => setTimeout(r, 100)); // the set fired its own check
        const dl = state.sent.find((s) => s.channel === "update-downloaded");
        assert.ok(dl, "the confirmed return re-downloaded the stable image");
        assert.equal(dl.payload.releaseName, "1.12.32-plotina.8");
        assert.equal(sha512B64(await fs.readFile(layout.current)), sha512B64(payload));
        const dlg = state.dialogs.at(-1);
        assert.ok(dlg && dlg.buttons.includes("Restart now"), "restart prompt shown for the reduction too");
        const prefs = JSON.parse(await fs.readFile(path.join(layout.userData, "plotina-update-channel.json"), "utf8"));
        assert.equal(prefs.channel, "stable");
    } finally {
        stub.restore();
    }
});

test("allowDowngrade is only honoured when the running build is a dev version", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    state.version = "1.12.32-plotina.7"; // a stable build, even lower than the feed's... use higher instead
    state.version = "1.12.32-plotina.10";
    const stub = stableFeedStub(layout, "1.12.32-plotina.9", Buffer.from("NOT-NEWER"));
    try {
        await updater.checkForUpdates(true, { allowDowngrade: true });
        assert.equal(state.sent.filter((s) => s.channel === "update-downloaded").length, 0, "stable builds never get silent downgrades");
    } finally {
        stub.restore();
    }
});

test("Desktop release filter ignores every other client in the shared repo", () => {
    assert.equal(updater.isDesktopReleaseTag("v1.12.32-plotina-desktop.38"), true);
    assert.equal(updater.isDesktopReleaseTag("v1.12.32-plotina-element.20"), true);
    assert.equal(updater.isDesktopReleaseTag("v4.12.8-plotina-lite-desktop.19"), false);
    assert.equal(updater.isDesktopReleaseTag("v26.10.1-plotina-x.30"), false);
    assert.equal(updater.isDesktopReleaseTag("v2.11.3-plotina-mobile.28"), false);
});

test("channel switch forgets a pending downloaded update", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const payload = Buffer.from("DEV-PENDING".repeat(1000));
    const sha = sha512B64(payload);
    const fileName = "Plotina-Desktop-1.12.32-plotina.9-dev.1.AppImage";
    const ymlText = builderYml({ version: "1.12.32-plotina.9-dev.1", fileName, sha512: sha, size: payload.length });
    const stub = stubFetch([
        { has: "dev-latest/latest-linux-dev.yml", respond: () => ymlResponse(ymlText) },
        { has: `dev-latest/${fileName}`, respond: () => new Response(Buffer.from(payload), { status: 200, headers: { "content-length": String(payload.length) } }) },
        { has: "plotina.cc/dl/latest-linux.yml", respond: () => new Response("not yet", { status: 404 }) },
        { has: "api.github.com", respond: () => json([]) },
    ]);
    try {
        await fs.writeFile(path.join(layout.userData, "plotina-update-channel.json"), JSON.stringify({ channel: "dev" }));
        await updater.checkForUpdates(true);
        assert.ok(state.sent.some((s) => s.channel === "update-downloaded"), "dev update staged/swapped first");

        // Switch back to stable (the /dl feed 404s here) -> the old pending
        // dev image must not be re-presented: the new check re-queries the feed.
        stub.calls.length = 0;
        state.sent.length = 0;
        const applied = updater.setUpdateChannel("stable");
        assert.equal(applied, "stable");
        await new Promise((r) => setTimeout(r, 50));
        assert.ok(stub.calls.some((u) => u === "https://plotina.cc/dl/latest-linux.yml"), "direct stable feed ran, not a cached-dev re-show");
        assert.ok(!stub.calls.some((u) => u.includes("api.github.com")), "stable check uses no GitHub API");
        assert.equal(state.sent.filter((s) => s.channel === "update-downloaded").length, 0, "no stale dev update-downloaded after switch");
    } finally {
        stub.restore();
    }
});

// --- stable direct-feed stub: /dl metadata + /dl alias artifact ------------
function stableFeedStub(layout, version, payload, { wrongSize = false } = {}) {
    const sha = sha512B64(payload);
    const fileName = `Plotina-Desktop-${version}.AppImage`;
    const ymlText = builderYml({ version, fileName, sha512: sha, size: wrongSize ? payload.length + 1 : payload.length });
    return stubFetch([
        { has: "plotina.cc/dl/latest-linux.yml", respond: () => ymlResponse(ymlText) },
        {
            has: "plotina.cc/dl/Plotina-Desktop.AppImage",
            respond: () => new Response(Buffer.from(payload), { status: 200, headers: { "content-length": String(payload.length) } }),
        },
        {
            has: "api.github.com",
            respond: (u) => {
                throw new Error(`stable path must never list releases through the API (${u})`);
            },
        },
    ]);
}
