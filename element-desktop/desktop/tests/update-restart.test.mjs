// Restart-lifecycle regression test for the updater (Linux AppImage path).
//
//   node --test element-desktop/desktop/tests/update-restart.test.mjs
//
// The bug (Plotina Desktop .44 -> .45, both platforms): after "Restart to
// update" the app simply turned off instead of coming back on Linux as the new
// version. Root cause: installUpdate() spawned the swapped AppImage directly
// and called app.quit(). app.quit() is ASYNCHRONOUS (before-quit, window
// teardown), the old main process keeps the Electron single-instance lock of
// the shared userData until it actually exits, and the new instance answers a
// denied requestSingleInstanceLock() with `Other instance detected: exiting`
// + app.exit() (upstream electron-main.ts). So: new process starts, dies on
// our own lock, old process quits, nothing is running.
//
// This test does not fake spawn: it runs the REAL updater in a real child
// process ("old app", holding a real lock), with a REAL app.quit() stand-in
// that exits ~250ms later, and a real swapped-in "new app" script that
// enforces the same lock semantics as Electron. It asserts process ORDER from
// event-log timestamps: the new instance must only start AFTER the old PID is
// gone, and it must come up alive. Against the pre-fix updater this test fails
// with "LOCK-BUSY" (the direct-spawn child dies against the live lock) — run it
// from the fix branch to see it pass.
//
// The Windows branch cannot exec a PE here; its contract (/S --updated
// --force-run, the flag that makes a silent NSIS install relaunch the app) is
// pinned in ./windows-restart-args.test.mjs, and the installer kill→install→
// relaunch ordering was verified by running the electron-builder 26.16.1 NSIS
// templates on Windows/wine.
import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "plotina-restart-"));
const sha512B64 = (buf) => createHash("sha512").update(buf).digest("base64");

// --- the "new app": same lock contract as Electron's requestSingleInstanceLock.
// It is a POSIX sh wrapper around node: the swapped file keeps the
// ".AppImage" name, and node refuses unknown extensions when exec'd by name.
const NEW_APP = `#!/bin/sh
exec node --input-type=module <<'PLOTINA_TEST_EOF'
import fs from "node:fs";
const lock = process.env.PLOTINA_TEST_LOCKDIR;
const ev = process.env.PLOTINA_TEST_EV;
const note = (s) => fs.appendFileSync(ev, s + "\\n");
function held(l) {
    try {
        fs.mkdirSync(l);
        return true;
    } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let pid = 0;
        try { pid = Number(fs.readFileSync(l + "/pid", "utf8")); } catch {}
        let alive = false;
        if (pid) { try { process.kill(pid, 0); alive = true; } catch {} }
        if (alive) return false;
        fs.rmSync(l, { recursive: true, force: true }); // stale lock, like Electron steals it
        fs.mkdirSync(l);
        return true;
    }
}
if (!held(lock)) {
    note("BUSY " + Date.now() + " " + process.pid);
    process.exit(42);
}
fs.writeFileSync(lock + "/pid", String(process.pid));
note("START " + Date.now() + " " + process.pid);
setTimeout(() => {
    note("ALIVE " + Date.now() + " " + process.pid);
    fs.rmSync(lock, { recursive: true, force: true });
    process.exit(0);
}, 1200);
PLOTINA_TEST_EOF
`;

// --- the "old app": the real updater module, real checkForUpdates against a
// local feed, dialog auto-answer "Restart now", real spawn, async quit.
const OLD_APP = `
import fsSync from "node:fs";
import { registerHooks } from "node:module";
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: import.meta.resolve(process.env.PLOTINA_STUB), shortCircuit: true };
        return nextResolve(specifier, context);
    },
});
const { state, app } = await import(process.env.PLOTINA_STUB);
state.version = "1.12.32-plotina.31";
state.isPackaged = true;
state.paths = { userData: process.env.PLOTINA_USERDATA, downloads: process.env.PLOTINA_USERDATA, home: process.env.PLOTINA_USERDATA };
state.dialogs = [];
state.dialogResponse = 0; // "Restart now": drive the real installUpdate() path
state.sent = [];
state.ipcHandlers = {};
globalThis.mainWindow = { webContents: { send: () => {} } };
process.resourcesPath = process.env.PLOTINA_RESOURCES;
// app.quit() is asynchronous in reality: before-quit/window teardown first,
// exit ~250ms later — precisely the window in which the pre-fix direct spawn
// child dies on the still-held lock.
app.quit = () => { state.quitCount++; setTimeout(() => process.exit(0), 250); };
fsSync.mkdirSync(process.env.PLOTINA_LOCKDIR, { recursive: true }); // we are THE instance
fsSync.writeFileSync(process.env.PLOTINA_LOCKDIR + "/pid", String(process.pid));
process.on("exit", () => { try { fsSync.rmSync(process.env.PLOTINA_LOCKDIR, { recursive: true, force: true }); } catch {} });

globalThis.fetch = async (u) => {
    if (u === "https://plotina.cc/dl/latest-linux.yml") return new Response(fsSync.readFileSync(process.env.PLOTINA_YML_FILE));
    if (u === "https://plotina.cc/dl/Plotina-Desktop.AppImage") return new Response(fsSync.readFileSync(process.env.PLOTINA_PAYLOAD_FILE));
    throw new Error("unexpected fetch " + u);
};
const updater = await import(process.env.PLOTINA_UPDATER);
await updater.checkForUpdates(true);
console.log("OLD-READY swap done, waiting for installUpdate -> quit");
setInterval(() => {}, 1000); // until the stubbed quit fires process.exit
`;

test("restart: new instance starts only after the old PID exited, and survives (real processes)", async () => {
    const root = await fs.mkdtemp(path.join(TMP, "flow-"));
    const appDir = path.join(root, "apps");
    const userData = path.join(root, "user-data");
    const resources = path.join(root, "resources");
    const lockDir = path.join(userData, "test-lock");
    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(resources, { recursive: true });
    const ev = path.join(root, "events.log");
    const current = path.join(appDir, "Plotina-Desktop-1.12.32-plotina.31.AppImage");
    await fs.writeFile(current, "OLD");
    await fs.chmod(current, 0o755);
    await fs.writeFile(path.join(resources, "app-update.yml"), "provider: github\nowner: plotina-cc\nrepo: clients\n");

    // The "new image": bytes of the fake new-app script; the updater swaps them
    // in and the restart execs them.
    const payload = Buffer.from(NEW_APP);
    const yml =
        `version: 1.12.32-plotina.33\npath: Plotina-Desktop-1.12.32-plotina.33.AppImage\nsha512: ${sha512B64(payload)}\n` +
        `files:\n  - url: Plotina-Desktop-1.12.32-plotina.33.AppImage\n    sha512: ${sha512B64(payload)}\n    size: ${payload.length}\n` +
        `releaseDate: '2026-11-05T00:00:00.000Z'\n`;
    const ymlFile = path.join(root, "latest-linux.yml");
    const payloadFile = path.join(root, "image.AppImage");
    await fs.writeFile(ymlFile, yml);
    await fs.writeFile(payloadFile, payload);

    const oldapp = path.join(root, "oldapp.mjs");
    await fs.writeFile(oldapp, OLD_APP);

    const env = {
        ...process.env,
        APPIMAGE: current, // UPDATE_MODE -> linux-appimage at import
        PLOTINA_STUB: path.join(HERE, "electron-stub.mjs"),
        PLOTINA_UPDATER: path.join(HERE, "..", "updater.ts"),
        PLOTINA_USERDATA: userData,
        PLOTINA_RESOURCES: resources,
        PLOTINA_LOCKDIR: lockDir,
        PLOTINA_TEST_EV: ev,
        PLOTINA_TEST_LOCKDIR: lockDir,
        PLOTINA_YML_FILE: ymlFile,
        PLOTINA_PAYLOAD_FILE: payloadFile,
    };
    const child = spawn(process.execPath, [oldapp], { env, stdio: ["ignore", "pipe", "pipe"] });
    let childOut = "";
    child.stdout.on("data", (d) => (childOut += d));
    child.stderr.on("data", (d) => (childOut += d));
    const exitInfo = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), 20000);
        child.on("exit", (code) => { clearTimeout(t); resolve({ code }); });
    });
    const oldExitTs = Date.now();
    assert.ok(!exitInfo.timeout, `old app never quit (installUpdate did not run/exit).\nold app output:\n${childOut}`);

    // The relaunched instance must appear via the helper, after the old PID died.
    const deadline = Date.now() + 10000;
    let events = "";
    while (Date.now() < deadline) {
        try { events = await fs.readFile(ev, "utf8"); } catch {}
        if (/^(START|BUSY)/m.test(events)) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    // wait for ALIVE too (the survivor check)
    const aliveDeadline = Date.now() + 4000;
    while (!/ALIVE/m.test(events) && Date.now() < aliveDeadline) {
        await new Promise((r) => setTimeout(r, 50));
        try { events = await fs.readFile(ev, "utf8"); } catch {}
    }
    const lines = events.trim().split(/\n/);
    assert.ok(!/^BUSY/m.test(events), `new instance hit the LIVE single-instance lock and died — this is the .44->.45 bug:\n${lines.join("\n")}`);
    const startLine = lines.find((l) => l.startsWith("START "));
    assert.ok(startLine, `the AppImage was never relaunched:\n${lines.join("\n")}\nold app output:\n${childOut}`);
    const startTs = Number(startLine.split(" ")[1]);
    const startPid = Number(startLine.split(" ")[2]);
    assert.ok(startTs >= oldExitTs - 50, `restart started at ${startTs} BEFORE old pid exited at ${oldExitTs} — order violated`);
    assert.notEqual(startPid, child.pid);
    assert.ok(/ALIVE/m.test(events), "relaunched instance did not survive (it died after starting)");
    // the swapped-in file really is the new image
    assert.equal((await fs.readFile(current)).toString(), NEW_APP, "AppImage at the restart path is the swapped-in new bytes");
    if (childOut) console.log("old app output:\n" + childOut.trim());
});
