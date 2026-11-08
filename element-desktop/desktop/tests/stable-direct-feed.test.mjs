// Stable-channel direct-feed tests for ../updater.ts: the stable check is a
// pair of plain GETs against our edge —
//
//   https://plotina.cc/dl/latest-linux.yml   -> metadata (Linux AppImage)
//   https://plotina.cc/dl/latest.yml         -> metadata (Windows NSIS)
//   https://plotina.cc/dl/Plotina-Desktop.AppImage     -> artifact (alias)
//   https://plotina.cc/dl/Plotina-Desktop-setup.exe    -> artifact (alias)
//
// — never an api.github.com release listing. Everything is served by a fetch
// stub from LOCAL fixtures: no network, no live GitHub, no live edge.
//
//   node --test element-desktop/desktop/tests/stable-direct-feed.test.mjs
//
// Same harness as linux-updater.test.mjs: "electron" maps to electron-stub.mjs
// via a resolve hook, ../updater.ts is imported through Node >= 22
// type-stripping, and UPDATE_MODE is decided at import (APPIMAGE set first).
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

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "plotina-direct-feed-test-"));
const sha512B64 = (buf) => createHash("sha512").update(buf).digest("base64");

async function makeLayout() {
    const root = await fs.mkdtemp(path.join(TMP, "case-"));
    const appDir = path.join(root, "apps");
    const userData = path.join(root, "user-data");
    const downloads = path.join(root, "Downloads");
    const resources = path.join(root, "resources");
    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(resources, { recursive: true });
    const current = path.join(appDir, "Plotina-Desktop-1.12.32-plotina.31.AppImage");
    await fs.writeFile(current, "OLD-IMAGE-CONTENT");
    await fs.chmod(current, 0o755);
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
    state.dialogResponse = 1; // "Later"
    state.quitCount = 0;
    state.sent = [];
    state.ipcHandlers = {};
    globalThis.mainWindow = { webContents: { send: (channel, payload) => state.sent.push({ channel, payload }) } };
    process.resourcesPath = layout.resources;
    process.env.APPIMAGE = layout.current;
    updater._resetUpdateStateForTests();
}

const firstLayout = await makeLayout();
process.env.APPIMAGE = firstLayout.current; // UPDATE_MODE = linux-appimage at import
const updater = await import("../updater.ts");
await fs.rm(firstLayout.current, { force: true });

// --- fetch route stub: records every URL, everything else 404s -------------
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

/** electron-builder metadata body; versioned fileName on purpose — the
 *  download must use the fixed /dl alias, not this name. */
function dlYml({ version, fileName, sha512, size }) {
    return [
        `version: ${version}`,
        "files:",
        `  - url: ${fileName}`,
        `    sha512: ${sha512}`,
        `    size: ${size}`,
        `    blockMapSize: 227568`,
        `path: ${fileName}`,
        `sha512: ${sha512}`,
        `size: ${size}`,
        "releaseDate: '2026-11-05T20:38:54.068Z'",
        "",
    ].join("\n");
}

// =========================================================================
// 1. Direct URL selection
// =========================================================================

test("D1 stable feed is the edge /dl, per platform, with stable aliases", () => {
    assert.equal(updater.PLOTINA_DL_BASE, "https://plotina.cc/dl");
    assert.equal(updater.STABLE_APPIMAGE_ALIAS, "Plotina-Desktop.AppImage");
    assert.equal(updater.STABLE_NSIS_ALIAS, "Plotina-Desktop-setup.exe");

    assert.equal(updater.stableMetadataFileName("linux", { APPIMAGE: "/a/b.AppImage" }), "latest-linux.yml");
    assert.equal(updater.stableMetadataFileName("win32", {}), "latest.yml");
    assert.equal(updater.stableMetadataFileName("linux", {}), null, "deb: no self-update feed at all");
    assert.equal(updater.stableMetadataFileName("darwin", {}), null);

    assert.equal(updater.stableMetadataUrl("linux", { APPIMAGE: "/a/b.AppImage" }), "https://plotina.cc/dl/latest-linux.yml");
    assert.equal(updater.stableMetadataUrl("win32", {}), "https://plotina.cc/dl/latest.yml");
    assert.equal(updater.stableMetadataUrl("linux", {}), null);

    assert.equal(updater.stableArtifactUrl("linux", { APPIMAGE: "/a/b.AppImage" }), "https://plotina.cc/dl/Plotina-Desktop.AppImage");
    assert.equal(updater.stableArtifactUrl("win32", {}), "https://plotina.cc/dl/Plotina-Desktop-setup.exe");
    assert.equal(updater.stableArtifactUrl("linux", {}), null);
    assert.equal(updater.stableArtifactUrl("freebsd", {}), null);
});

// =========================================================================
// 2. Metadata parse through the live-shaped feed contract
// =========================================================================

test("D2 parseable /dl metadata is accepted; garbage is a reported error", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const payload = Buffer.from("GOOD-ALIAS-BYTES".repeat(2048));
    const good = dlYml({
        version: "1.12.32-plotina.32",
        fileName: "Plotina-Desktop-1.12.32-plotina.32.AppImage",
        sha512: sha512B64(payload),
        size: payload.length,
    });
    const stub = stubFetch([
        { has: "plotina.cc/dl/latest-linux.yml", respond: () => new Response(good, { status: 200 }) },
        { has: "plotina.cc/dl/Plotina-Desktop.AppImage", respond: () => new Response(Buffer.from(payload), { status: 200 }) },
    ]);
    try {
        await updater.checkForUpdates(true);
        assert.ok(state.sent.some((s) => s.channel === "update-downloaded"), "parseable feed -> update installed");
    } finally {
        stub.restore();
        updater._resetUpdateStateForTests();
    }

    const layout2 = await makeLayout();
    resetStubs(layout2);
    const garbage = stubFetch([{ has: "plotina.cc/dl/latest-linux.yml", respond: () => new Response("<html>502 bad gateway</html>", { status: 200 }) }]);
    try {
        await updater.checkForUpdates(true);
        const err = state.sent.find((s) => s.channel === "check_updates" && typeof s.payload === "string");
        assert.ok(err && /not parseable/.test(err.payload), `garbage body must surface as an error: ${JSON.stringify(state.sent)}`);
        assert.equal(await fs.readFile(layout2.current, "utf8"), "OLD-IMAGE-CONTENT", "garbage never touches the image");
    } finally {
        garbage.restore();
    }
});

test("D2b HTTP error on the metadata GET surfaces on a manual check", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const stub = stubFetch([{ has: "plotina.cc/dl/latest-linux.yml", respond: () => new Response("nope", { status: 503 }) }]);
    try {
        await updater.checkForUpdates(true);
        const err = state.sent.find((s) => s.channel === "check_updates" && typeof s.payload === "string");
        assert.ok(err && /HTTP 503/.test(err.payload), `503 must surface: ${JSON.stringify(state.sent)}`);
        assert.equal(state.sent.filter((s) => s.channel === "update-downloaded").length, 0);
    } finally {
        stub.restore();
    }
});

// =========================================================================
// 3. Version filtering on the direct feed
// =========================================================================

test("D3 same and older versions are refused without downloading anything", async () => {
    for (const offered of ["1.12.32-plotina.31", "1.12.32-plotina.30"]) {
        const layout = await makeLayout();
        resetStubs(layout);
        const stub = stubFetch([
            {
                has: "plotina.cc/dl/latest-linux.yml",
                respond: () =>
                    new Response(
                        dlYml({ version: offered, fileName: `Plotina-Desktop-${offered}.AppImage`, sha512: "AAA=", size: 123 }),
                        { status: 200 },
                    ),
            },
        ]);
        try {
            await updater.checkForUpdates(true);
            assert.ok(
                state.sent.some((s) => s.channel === "check_updates" && s.payload === false),
                `${offered} vs running .31: manual check must answer "no update"`,
            );
            assert.deepEqual(
                stub.calls,
                ["https://plotina.cc/dl/latest-linux.yml"],
                "only the metadata GET; the artifact is never fetched for a refused version",
            );
            assert.equal(await fs.readFile(layout.current, "utf8"), "OLD-IMAGE-CONTENT");
        } finally {
            stub.restore();
        }
    }
});

test("D3b an older STABLE is installed only by the confirmed return-to-stable", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    state.version = "1.12.32-plotina.33-dev.1"; // a dev build may go back
    const payload = Buffer.from("OLDER-STABLE-IMAGE".repeat(2048));
    const stub = stubFetch([
        {
            has: "plotina.cc/dl/latest-linux.yml",
            respond: () =>
                new Response(
                    dlYml({
                        version: "1.12.32-plotina.32",
                        fileName: "Plotina-Desktop-1.12.32-plotina.32.AppImage",
                        sha512: sha512B64(payload),
                        size: payload.length,
                    }),
                    { status: 200 },
                ),
        },
        { has: "plotina.cc/dl/Plotina-Desktop.AppImage", respond: () => new Response(Buffer.from(payload), { status: 200 }) },
    ]);
    try {
        await updater.checkForUpdates(true, { allowDowngrade: true });
        assert.ok(state.sent.some((s) => s.channel === "update-downloaded"), "confirmed return installs the lower stable");
        assert.equal(sha512B64(await fs.readFile(layout.current)), sha512B64(payload));
    } finally {
        stub.restore();
    }
});

// =========================================================================
// 4. No api.github.com — anywhere on the stable path
// =========================================================================

test("D4 a stable check touches only plotina.cc/dl, never github.com", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const payload = Buffer.from("EDGE-ONLY-BYTES".repeat(2048));
    const stub = stubFetch([
        {
            has: "plotina.cc/dl/latest-linux.yml",
            respond: () =>
                new Response(
                    dlYml({
                        version: "1.12.32-plotina.35",
                        fileName: "Plotina-Desktop-1.12.32-plotina.35.AppImage",
                        sha512: sha512B64(payload),
                        size: payload.length,
                    }),
                    { status: 200 },
                ),
        },
        { has: "plotina.cc/dl/Plotina-Desktop.AppImage", respond: () => new Response(Buffer.from(payload), { status: 200 }) },
    ]);
    try {
        await updater.checkForUpdates(true);
        assert.deepEqual(stub.calls, [
            "https://plotina.cc/dl/latest-linux.yml",
            "https://plotina.cc/dl/Plotina-Desktop.AppImage",
        ], `exactly the two edge GETs: ${JSON.stringify(stub.calls)}`);
        assert.ok(!stub.calls.some((u) => u.includes("api.github.com")), "no GitHub API release listing");
        assert.ok(!stub.calls.some((u) => u.includes("github.com")), "no GitHub at all on the stable path");
    } finally {
        stub.restore();
    }
});

test("D4b a foreign product's artifact name in the feed is refused with an error", async () => {
    const layout = await makeLayout();
    resetStubs(layout);
    const stub = stubFetch([
        {
            has: "plotina.cc/dl/latest-linux.yml",
            respond: () =>
                new Response(
                    dlYml({ version: "4.12.8-plotina.19", fileName: "Plotina-Lite-Desktop-4.12.8-plotina.19-x86_64.AppImage", sha512: "AAA=", size: 123 }),
                    { status: 200 },
                ),
        },
    ]);
    try {
        await updater.checkForUpdates(true);
        const err = state.sent.find((s) => s.channel === "check_updates" && typeof s.payload === "string");
        assert.ok(err && /not a Plotina Desktop artifact/.test(err.payload), `foreign fileName must be refused: ${JSON.stringify(state.sent)}`);
        assert.equal(stub.calls.length, 1, "the misdescribed artifact is never downloaded");
        assert.equal(await fs.readFile(layout.current, "utf8"), "OLD-IMAGE-CONTENT");
    } finally {
        stub.restore();
    }
});
