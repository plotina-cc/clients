// Linux AppImage self-update tests for ../updater.ts.
//
//   node --test element-desktop/desktop/tests/linux-updater.test.mjs
//
// "electron" is mapped to ./electron-stub.mjs via a resolve hook, and
// ../updater.ts is imported directly thanks to Node >= 22 type-stripping.
// Everything runs under $TMPDIR (or /tmp): fake AppImages are ordinary files
// — the updater never opens them, it only downloads, hashes, chmods and
// renames. No test touches the network: the stable feed is served through a
// fetch stub from LOCAL FIXTURES (a captured real latest-linux.yml), the way
// the live edge serves it.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { state } from "./electron-stub.mjs";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "plotina-updater-test-"));

// --- scratch layout ------------------------------------------------------
async function makeLayout({ currentName = "Plotina-Desktop-1.12.32-plotina.31.AppImage", dirMode = 0o755 } = {}) {
    const root = await fs.mkdtemp(path.join(TMP, "case-"));
    const appDir = path.join(root, "apps");
    const userData = path.join(root, "user-data");
    const downloads = path.join(root, "Downloads");
    const resources = path.join(root, "resources");
    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(resources, { recursive: true });
    const current = path.join(appDir, currentName);
    await fs.writeFile(current, "OLD-IMAGE-CONTENT");
    await fs.chmod(current, 0o755);
    if (dirMode !== 0o755) await fs.chmod(appDir, dirMode);
    await fs.writeFile(
        path.join(resources, "app-update.yml"),
        "provider: github\nowner: plotina-cc\nrepo: clients\n",
    );
    return { root, appDir, userData, downloads, resources, current };
}

function resetStubs(layout) {
    state.version = "1.12.32-plotina.31";
    state.isPackaged = true;
    state.paths = { userData: layout.userData, downloads: layout.downloads, home: layout.root };
    state.dialogs = [];
    state.dialogResponse = 1;
    state.quitCount = 0;
    state.sent = [];
    state.ipcHandlers = {};
    globalThis.mainWindow = { webContents: { send: (channel, payload) => state.sent.push({ channel, payload }) } };
    process.resourcesPath = layout.resources;
}

// --- electron -> stub resolution, then load the real updater -------------
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "electron") {
            return { url: import.meta.resolve("./electron-stub.mjs"), shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});

const firstLayout = await makeLayout();
process.env.APPIMAGE = firstLayout.current; // must be set BEFORE importing: UPDATE_MODE is decided at import
const updater = await import("../updater.ts");

const sha512B64 = (buf) => createHash("sha512").update(buf).digest("base64");

// --- tiny local "release server" ------------------------------------------
function startServer(payload) {
    let requests = 0;
    const server = http.createServer((_req, res) => {
        requests++;
        res.writeHead(200, { "content-length": String(payload.length) });
        res.end(payload);
    });
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () =>
            resolve({
                url: `http://127.0.0.1:${server.address().port}/image.AppImage`,
                requestCount: () => requests,
                close: () => new Promise((r) => server.close(r)),
            }),
        ),
    );
}

// =========================================================================
test("detectUpdateMode picks the right path per platform/env", () => {
    assert.equal(updater.detectUpdateMode("win32", {}), "windows-installer");
    assert.equal(updater.detectUpdateMode("linux", { APPIMAGE: "/x/y.AppImage" }), "linux-appimage");
    assert.equal(updater.detectUpdateMode("linux", {}), "linux-deb");
    assert.equal(updater.detectUpdateMode("linux", { APPIMAGE: "" }), "linux-deb");
    assert.equal(updater.detectUpdateMode("darwin", {}), "unsupported");
    assert.match(updater.DEB_UPDATE_GUIDANCE, /apt upgrade/);
});

test("isVersionNewer compares Plotina versions", () => {
    assert.equal(updater.isVersionNewer("1.12.32-plotina.33", "1.12.32-plotina.31"), true);
    assert.equal(updater.isVersionNewer("1.12.32-plotina.31", "1.12.32-plotina.33"), false);
    assert.equal(updater.isVersionNewer("1.12.32-plotina.31", "1.12.32-plotina.31"), false);
    assert.equal(updater.isVersionNewer("1.13.0", "1.12.32-plotina.34"), true);
});

// Real latest-linux.yml captured from the public release
// v1.12.32-plotina-desktop.33 (AppImage first, deb second, blockMapSize —
// exactly the shape electron-builder 26.x publishes). Fixture, not live: the
// parser contract must be pinned without network.
const REAL_LINUX_YML = `version: 1.12.32-plotina.33
files:
  - url: Plotina-Desktop-1.12.32-plotina.33.AppImage
    sha512: OYFtYvFf1zBaJMzIIX6j4Ic9wE7hsENCtqT6FEM3CmY8X7LenwT/IkH04hG3h0yFYpAQtJFW/BHc2CBXt2oTiA==
    size: 218159324
    blockMapSize: 227568
  - url: plotina-desktop_1.12.32-plotina.33_amd64.deb
    sha512: /g1CwBDyEzxeV+I1SvkTDCMWeJsIf2PyeWVeXsz4ZIpKNCJwjxrcw0f/lL2C4aBW566HBqTXcuN8Dgs34ftdZg==
    size: 159194620
path: Plotina-Desktop-1.12.32-plotina.33.AppImage
sha512: OYFtYvFf1zBaJMzIIX6j4Ic9wE7hsENCtqT6FEM3CmY8X7LenwT/IkH04hG3h0yFYpAQtJFW/BHc2CBXt2oTiA==
releaseDate: '2026-11-05T20:38:54.068Z'
`;

test("parseLatestYml reads the real latest-linux.yml shape", () => {
    const yml = updater.parseLatestYml(REAL_LINUX_YML);
    assert.ok(yml, "latest-linux.yml must parse");
    assert.equal(yml.version, "1.12.32-plotina.33");
    assert.equal(yml.fileName, "Plotina-Desktop-1.12.32-plotina.33.AppImage", "must name the AppImage, not the deb");
    assert.match(yml.sha512, /^[\w+/]{86}==$/);
    assert.equal(yml.size, 218159324, "top-level size describes the AppImage");
    assert.equal(yml.releaseDate, "2026-11-05T20:38:54.068Z");
});

test("stable direct URLs: metadata on /dl, artifact alias, never api.github.com", () => {
    assert.equal(
        updater.stableMetadataUrl("linux", { APPIMAGE: "/x/Plotina.AppImage" }),
        "https://plotina.cc/dl/latest-linux.yml",
    );
    assert.equal(updater.stableMetadataUrl("win32", {}), "https://plotina.cc/dl/latest.yml");
    assert.equal(updater.stableMetadataUrl("linux", {}), null, "deb installs have no direct self-update feed");
    assert.equal(updater.stableMetadataUrl("darwin", {}), null);
    assert.equal(
        updater.stableArtifactUrl("linux", { APPIMAGE: "/x/Plotina.AppImage" }),
        "https://plotina.cc/dl/Plotina-Desktop.AppImage",
    );
    assert.equal(updater.stableArtifactUrl("win32", {}), "https://plotina.cc/dl/Plotina-Desktop-setup.exe");
    assert.equal(updater.stableArtifactUrl("linux", {}), null);
    assert.equal(updater.stableArtifactUrl("freebsd", {}), null);
});

test("stageAppImage refuses a sha512 mismatch and keeps the running image", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const payload = Buffer.alloc(1024 * 1024, "good-bytes");
    const srv = await startServer(payload); // server content ...
    try {
        const wrongSha = sha512B64(Buffer.alloc(1024 * 1024, "other-bytes")); // ... differs from feed digest
        await assert.rejects(
            updater.stageAppImage(srv.url, layout.current, wrongSha, "Plotina-Desktop-x.AppImage"),
            /sha512 mismatch/,
        );
        const dirEntries = await fs.readdir(layout.appDir);
        assert.deepEqual(dirEntries, [path.basename(layout.current)], "no half-download left next to the image");
        assert.equal(await fs.readFile(layout.current, "utf8"), "OLD-IMAGE-CONTENT", "running image untouched");
        const userEntries = await fs.readdir(path.join(layout.userData, "plotina-updates")).catch(() => []);
        assert.equal(userEntries.filter((f) => f.endsWith(".part")).length, 0);
    } finally {
        await srv.close();
    }
});

test("stageAppImage downloads, verifies, chmods +x, and reuses the staged file", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const payload = Buffer.from("NEW-APPIMAGE-BYTES".repeat(64 * 1024)); // ~1.2 MB
    const sha = sha512B64(payload);
    const srv = await startServer(payload);
    try {
        const staged = await updater.stageAppImage(srv.url, layout.current, sha, "Plotina-Desktop-x.AppImage");
        assert.equal(staged, path.join(layout.appDir, "Plotina-Desktop-x.AppImage.plotina-new"), "staged next to the running image");
        assert.equal(sha512B64(await fs.readFile(staged)), sha);
        const st = await fs.stat(staged);
        assert.ok(st.mode & 0o111, "staged image is executable");
        const again = await updater.stageAppImage(srv.url, layout.current, sha, "Plotina-Desktop-x.AppImage");
        assert.equal(again, staged);
        assert.equal(srv.requestCount(), 1, "second run reuses the verified staged file, no re-download");
    } finally {
        await srv.close();
    }
});

test("swapAppImage renames atomically over the current image", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const staged = path.join(layout.appDir, "new.plotina-new");
    await fs.writeFile(staged, "SWAPPED-CONTENT"); // 644 on purpose: swap must force +x
    await fs.chmod(staged, 0o644);
    const result = await updater.swapAppImage(staged, layout.current, layout.downloads);
    assert.deepEqual(result, { swapped: true });
    assert.equal(await fs.readFile(layout.current, "utf8"), "SWAPPED-CONTENT");
    assert.ok((await fs.stat(layout.current)).mode & 0o111, "swapped-in image is executable even if staged file was not");
    assert.ok(!(await fs.stat(staged).catch(() => false)), "staged file consumed by the rename");
    const dirEntries = await fs.readdir(layout.appDir);
    assert.deepEqual(dirEntries, [path.basename(layout.current)]);
});

test("swapAppImage survives a cross-filesystem staged path (EXDEV)", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    let shmDir = null;
    try {
        shmDir = path.join("/dev/shm", `plotina-test-${process.pid}`);
        await fs.mkdir(shmDir, { recursive: true });
    } catch {
        console.log("EXDEV case: /dev/shm unavailable, skipping");
        return;
    }
    try {
        const sameFs = fsSync.statfsSync(layout.appDir).fsid === fsSync.statfsSync(shmDir).fsid;
        const staged = path.join(shmDir, "far.plotina-new");
        await fs.writeFile(staged, "FAR-CONTENT");
        const result = await updater.swapAppImage(staged, layout.current, layout.downloads);
        assert.equal(result.swapped, true, sameFs ? "(same fs: rename path)" : "(EXDEV: copy+rename path)");
        assert.equal(await fs.readFile(layout.current, "utf8"), "FAR-CONTENT");
    } finally {
        await fs.rm(shmDir, { recursive: true, force: true });
    }
});

test("unwritable AppImage dir: verified image lands in Downloads, old file untouched", async (t) => {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
        t.skip("running as root: a 0555 dir cannot block file creation");
        return;
    }
    const layout = await makeLayout({ dirMode: 0o555 });
    resetStubs(layout);
    const payload = Buffer.from("UNSWAPPABLE-IMAGE".repeat(1000));
    const sha = sha512B64(payload);
    const srv = await startServer(payload);
    try {
        const staged = await updater.stageAppImage(srv.url, layout.current, sha, "Plotina-Desktop-y.AppImage");
        assert.ok(staged.startsWith(layout.userData), "staging falls back to userData when the dir is read-only");
        const result = await updater.swapAppImage(staged, layout.current, layout.downloads);
        assert.equal(result.swapped, false);
        assert.equal(result.savedTo, path.join(layout.downloads, "Plotina-Desktop-y.AppImage"));
        assert.equal(sha512B64(await fs.readFile(result.savedTo)), sha);
        assert.ok((await fs.stat(result.savedTo)).mode & 0o111, "saved image is executable");
        assert.equal(await fs.readFile(layout.current, "utf8"), "OLD-IMAGE-CONTENT", "running image untouched");
    } finally {
        await fs.chmod(layout.appDir, 0o755); // so cleanup can remove it
        await srv.close();
    }
});

test("deb install: manual check replies with apt guidance, no network", async () => {
    // detectUpdateMode("linux", {}) is linux-deb; the module here is in
    // appimage mode, so assert the exported contract the deb branch uses.
    assert.equal(updater.detectUpdateMode("linux", {}), "linux-deb");
    assert.match(updater.DEB_UPDATE_GUIDANCE, /sudo apt update && sudo apt upgrade/);
    assert.ok(!updater.DEB_UPDATE_GUIDANCE.includes("AppImage"), "deb users must not be told to swap AppImages");
});

// =========================================================================
// The real thing, from fixtures: a full stable check served by a fetch stub
// that behaves like https://plotina.cc/dl — the metadata names the VERSIONED
// AppImage while the alias URL holds the same bytes. Proves direct URL
// selection, sha512+size verification and the atomic swap end to end without
// touching GitHub (API or otherwise).
// =========================================================================
test("e2e: direct /dl feed downloads the alias AppImage, verifies sha512+size, swaps, prompts restart", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    process.env.APPIMAGE = layout.current; // UPDATE_MODE stays linux-appimage; path is re-read per call

    const payload = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("NEW-APPIMAGE-BYTES".repeat(4096))]); // ELF header + ~90 KB
    const sha = sha512B64(payload);
    // The feed names the versioned artifact; /dl only ever serves the alias.
    const ymlText = [
        "version: 1.12.32-plotina.33",
        "files:",
        "  - url: Plotina-Desktop-1.12.32-plotina.33.AppImage",
        `    sha512: ${sha}`,
        `    size: ${payload.length}`,
        "path: Plotina-Desktop-1.12.32-plotina.33.AppImage",
        `sha512: ${sha}`,
        `size: ${payload.length}`,
        "releaseDate: '2026-11-05T20:38:54.068Z'",
        "",
    ].join("\n");
    const calls = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u === "https://plotina.cc/dl/latest-linux.yml") return new Response(ymlText, { status: 200 });
        if (u === "https://plotina.cc/dl/Plotina-Desktop.AppImage") {
            return new Response(Buffer.from(payload), { status: 200, headers: { "content-length": String(payload.length) } });
        }
        return new Response("unstubbed: " + u, { status: 404 });
    };
    try {
        await updater.checkForUpdates(true);
    } finally {
        globalThis.fetch = real;
    }

    // 1. The whole check used the direct edge URLs and NOTHING else:
    //    no api.github.com listing, no github.com asset download.
    assert.deepEqual(calls, [
        "https://plotina.cc/dl/latest-linux.yml",
        "https://plotina.cc/dl/Plotina-Desktop.AppImage",
    ], `exactly the two direct /dl GETs: ${JSON.stringify(calls)}`);
    assert.ok(!calls.some((u) => u.includes("api.github.com") || u.includes("github.com")), "no GitHub API usage");

    // 2. UI flow mirrors Windows: status update-available, then update-downloaded.
    const channels = state.sent.map((s) => s.channel);
    assert.ok(channels.includes("check_updates"), "renderer got check_updates");
    assert.ok(channels.includes("update-downloaded"), "renderer got update-downloaded");
    const dl = state.sent.find((s) => s.channel === "update-downloaded");
    assert.equal(dl.payload.releaseName, "1.12.32-plotina.33");
    assert.equal(dl.payload.updateURL, "https://plotina.cc/dl/Plotina-Desktop.AppImage");

    // 3. The old file is gone, replaced by the verified image, executable, nothing left behind.
    const dirEntries = await fs.readdir(layout.appDir);
    assert.deepEqual(dirEntries, [path.basename(layout.current)], "no .part/.plotina-new leftovers");
    const swappedBytes = await fs.readFile(layout.current);
    assert.equal(sha512B64(swappedBytes), sha, "swapped-in bytes match the published sha512");
    assert.equal(swappedBytes.length, payload.length, "swapped-in bytes match the published size");
    assert.ok(swappedBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), "swapped file is an ELF AppImage");
    assert.ok((await fs.stat(layout.current)).mode & 0o111, "swapped file is executable");

    // 4. The restart dialog fired against the swapped image.
    const dlg = state.dialogs.at(-1);
    assert.ok(dlg && dlg.buttons.includes("Restart now"), "restart dialog shown");

    // 5. "Restart" re-launches the same path (now the new image) detached and quits.
    const spawns = [];
    const fakeSpawn = (target, args, opts) => {
        spawns.push({ target, args, opts });
        return { on: () => {}, unref: () => {} };
    };
    updater.installUpdate(fakeSpawn);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].target, layout.current);
    assert.deepEqual(spawns[0].args, []);
    assert.equal(spawns[0].opts.detached, true);
    assert.equal(state.quitCount, 1, "app.quit called for the restart");
    assert.equal(globalThis.appQuitting, true);

    // 6. Re-check short-circuits to the cached update, like Windows does.
    const before = state.sent.length;
    const callsBefore = calls.length;
    await updater.checkForUpdates(true);
    assert.ok(state.sent.slice(before).some((s) => s.channel === "update-downloaded"), "pending update re-shown");
    assert.equal(calls.length, callsBefore, "a pending update re-fetches nothing");
});
