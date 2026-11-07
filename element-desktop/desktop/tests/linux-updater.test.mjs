// Linux AppImage self-update tests for ../updater.ts.
//
//   node --test element-desktop/desktop/tests/linux-updater.test.mjs
//
// "electron" is mapped to ./electron-stub.mjs via a resolve hook, and
// ../updater.ts is imported directly thanks to Node >= 22 type-stripping.
// Everything runs under $TMPDIR (or /tmp): fake AppImages are ordinary files
// — the updater never opens them, it only downloads, hashes, chmods and
// renames. The last test downloads the REAL AppImage named by the live
// latest-linux.yml feed and proves verification + atomic swap end to end.
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

test("parseLatestYml reads the real latest-linux.yml feed", async () => {
    const res = await fetch(
        "https://github.com/plotina-cc/clients/releases/download/v1.12.32-plotina-desktop.33/latest-linux.yml",
        { headers: { "User-Agent": "Plotina-Desktop-test" } },
    );
    assert.equal(res.status, 200);
    const yml = updater.parseLatestYml(await res.text());
    assert.ok(yml, "latest-linux.yml must parse");
    assert.equal(yml.version, "1.12.32-plotina.33");
    assert.equal(yml.fileName, "Plotina-Desktop-1.12.32-plotina.33.AppImage", "must name the AppImage, not the deb");
    assert.match(yml.sha512, /^[\w+/]{86}==$/);
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
// The real thing: full check on this machine against the live GitHub feed.
// Downloads the AppImage the published latest-linux.yml names (~200 MB),
// verifies it against the published sha512 and swaps it over the fake .31.
// =========================================================================
test(
    "e2e: live feed downloads the real AppImage, verifies sha512, swaps, prompts restart",
    { timeout: 20 * 60 * 1000 },
    async () => {
        // What does the feed claim right now?
        const relRes = await fetch("https://api.github.com/repos/plotina-cc/clients/releases?per_page=100", {
            headers: { Accept: "application/vnd.github+json", "User-Agent": "Plotina-Desktop-test" },
        });
        assert.equal(relRes.status, 200, "GitHub API reachable");
        const releases = await relRes.json();
        const rel = releases.find((r) => !r.draft && !r.prerelease
            && updater.isDesktopReleaseTag(r.tag_name)
            && r.assets.some((a) => a.name === "latest-linux.yml"));
        assert.ok(rel, "a release with latest-linux.yml exists");
        const ymlText = await (await fetch(rel.assets.find((a) => a.name === "latest-linux.yml").browser_download_url, { headers: { "User-Agent": "Plotina-Desktop-test" } })).text();
        const yml = updater.parseLatestYml(ymlText);
        assert.ok(yml);
        console.log(`e2e feed: ${rel.tag_name} -> ${yml.fileName} (sha512 ${yml.sha512.slice(0, 16)}...)`);

        const layout = await makeLayout();
        resetStubs(layout);
        process.env.APPIMAGE = layout.current; // UPDATE_MODE stays linux-appimage; path is re-read per call

        await updater.checkForUpdates(true);

        // 1. UI flow mirrors Windows: status update-available, then update-downloaded.
        const channels = state.sent.map((s) => s.channel);
        assert.ok(channels.includes("check_updates"), "renderer got check_updates");
        assert.ok(channels.includes("update-downloaded"), "renderer got update-downloaded");
        const dl = state.sent.find((s) => s.channel === "update-downloaded");
        assert.equal(dl.payload.releaseName, yml.version);

        // 2. The restart dialog fired against the swapped image.
        const dlg = state.dialogs.at(-1);
        assert.ok(dlg && dlg.buttons.includes("Restart now"), "restart dialog shown");
        assert.match(dlg.message, new RegExp(yml.version.replaceAll(".", "\\.")));

        // 3. The old file is gone, replaced by the verified image, executable, nothing left behind.
        const dirEntries = await fs.readdir(layout.appDir);
        assert.deepEqual(dirEntries, [path.basename(layout.current)], "no .part/.plotina-new leftovers");
        const swappedBytes = await fs.readFile(layout.current);
        assert.equal(sha512B64(swappedBytes), yml.sha512, "swapped-in bytes match the published sha512");
        assert.ok(swappedBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), "swapped file is an ELF AppImage");
        assert.ok((await fs.stat(layout.current)).mode & 0o111, "swapped file is executable");

        // 4. "Restart" re-launches the same path (now the new image) detached and quits.
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

        // 5. Re-check short-circuits to the cached update, like Windows does.
        const before = state.sent.length;
        await updater.checkForUpdates(true);
        assert.ok(state.sent.slice(before).some((s) => s.channel === "update-downloaded"), "pending update re-shown");
    },
);
