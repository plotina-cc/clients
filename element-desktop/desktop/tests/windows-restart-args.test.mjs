// Windows installUpdate argument contract (the NSIS relaunch bug half).
//
//   node --test element-desktop/desktop/tests/windows-restart-args.test.mjs
//
// Root cause on Windows: electron-builder 26.16.1 NSIS (verified against its
// own shipped templates: installSection.nsh, ONE_CLICK + RUN_AFTER_FINISH
// branch) starts the app after install ONLY when the installer is not silent
// or --force-run is on the command line (nsisScriptGenerator flags() maps
// "--force-run" to ${isForceRun}). Our updater ran `/S --updated`: the
// installer silently killed the running app
// (allowOnlyOneInstallerInstance.nsh taskkill+wait), installed, and never
// relaunched — "Restart to update" became "turn off". The fix is to pass
// `/S --updated --force-run`, exactly what electron-updater's own
// quitAndInstall(forceRunAfter) does.
//
// A Linux test cannot exec the produced PE, so this pins the CONTRACT the
// updater controls; the installer side (kill -> install -> relaunch order) was
// exercised on a Windows/wine machine with the same templates (see the commit
// message / task report).
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Win32 BEFORE importing the updater: UPDATE_MODE is decided at import time.
Object.defineProperty(process, "platform", { value: "win32", configurable: true });

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "plotina-win-restart-"));
const root = await fs.mkdtemp(path.join(TMP, "case-"));
const userData = path.join(root, "user-data");
const resources = path.join(root, "resources");
await fs.mkdir(userData, { recursive: true });
await fs.mkdir(resources, { recursive: true });
await fs.writeFile(path.join(resources, "app-update.yml"), "provider: github\nowner: plotina-cc\nrepo: clients\n");

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: import.meta.resolve("./electron-stub.mjs"), shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
const { state } = await import("./electron-stub.mjs");
const updater = await import("../updater.ts");

const payload = Buffer.concat([Buffer.from("MZ"), Buffer.from("\0".repeat(1024))]);
const sha = createHash("sha512").update(payload).digest("base64");
const YML = `version: 1.12.32-plotina.45\npath: Plotina-Desktop-1.12.32-plotina.45-setup.exe\nsha512: ${sha}\nfiles:\n  - url: Plotina-Desktop-1.12.32-plotina.45-setup.exe\n    sha512: ${sha}\n    size: ${payload.length}\nreleaseDate: '2026-11-05T00:00:00.000Z'\n`;

function stubFetch(calls) {
    const real = globalThis.fetch;
    globalThis.fetch = async (u) => {
        calls.push(u);
        if (u === "https://plotina.cc/dl/latest.yml") return new Response(YML, { status: 200 });
        if (u === "https://plotina.cc/dl/Plotina-Desktop-setup.exe")
            return new Response(Buffer.from(payload), { status: 200, headers: { "content-length": String(payload.length) } });
        return new Response("unstubbed: " + u, { status: 404 });
    };
    return () => (globalThis.fetch = real);
}

test("Windows installUpdate runs the silent installer WITH --force-run", async () => {
    state.version = "1.12.32-plotina.44";
    state.isPackaged = true;
    state.paths = { userData, downloads: path.join(root, "downloads"), home: root };
    state.dialogs = [];
    state.dialogResponse = 1; // "Later": let the test click Restart itself
    state.quitCount = 0;
    state.sent = [];
    globalThis.mainWindow = { webContents: { send: (c, p) => state.sent.push({ channel: c, payload: p }) } };
    process.resourcesPath = resources;

    const calls = [];
    const restore = stubFetch(calls);
    try {
        await updater.checkForUpdates(true);
    } finally {
        restore();
    }
    assert.deepEqual(calls, ["https://plotina.cc/dl/latest.yml", "https://plotina.cc/dl/Plotina-Desktop-setup.exe"]);
    const dlg = state.dialogs.at(-1);
    assert.ok(dlg && dlg.buttons.includes("Restart to update"), "restart dialog shown");
    const installerPath = path.join(userData, "plotina-updates", "Plotina-Desktop-1.12.32-plotina.45-setup.exe");
    assert.equal(dlg.message.includes("1.12.32-plotina.45"), true);

    const spawns = [];
    const fakeSpawn = (target, args, opts) => {
        spawns.push({ target, args, opts });
        return { on: () => {}, unref: () => {} };
    };
    updater.installUpdate(fakeSpawn);
    assert.equal(spawns.length, 1);
    const s = spawns[0];
    assert.equal(s.target, installerPath, "the verified installer we downloaded is what runs");
    // /S silent, --updated keeps shortcuts/user data, --force-run is what
    // actually relaunches the app after the silent install (the fix).
    assert.deepEqual(s.args, ["/S", "--updated", "--force-run"], "silent update install must force a relaunch");
    assert.equal(s.opts.detached, true);
    assert.equal(s.opts.stdio, "ignore");
    assert.equal(state.quitCount, 1, "app.quit called for the update");
    assert.equal(globalThis.appQuitting, true);
});

test("Linux AppImage path never spawns the image directly (win32 module guard)", () => {
    // The linux helper contract lives in update-restart.test.mjs; here we only
    // assert that detectUpdateMode on win32 picks the installer path, so the
    // two branches cannot be confused in a single build.
    assert.equal(updater.detectUpdateMode("win32", { APPIMAGE: "/ignored.AppImage" }), "windows-installer");
});
