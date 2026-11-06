// Smoke: window state persists when the window closes normally.
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const CDP_PORT = 14477;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-ws-'));
const proc = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [
  APP_DIR, `--remote-debugging-port=${CDP_PORT}`,
], { env: { ...process.env, LITE_PORT: '0', LITE_USER_DATA: profileDir, LITE_DIST: '/home/hermes/.hermes/cache/scratch/cinny-dist-backup' } });
proc.stdout.on('data', (d) => process.stdout.write('[app-out] ' + d));
proc.stderr.on('data', (d) => process.stdout.write('[app] ' + d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0; const pend = new Map();
async function firstPage() {
  try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).find((t) => t.type === 'page'); } catch { return null; }
}
for (let i = 0; i < 40 && !(await firstPage()); i++) await sleep(400);
const t = await firstPage();
ws = new WebSocket(t.webSocketDebuggerUrl); // page endpoint: Runtime + window ops
await new Promise((res) => (ws.onopen = res));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.error ?? m.result); pend.delete(m.id); } };
const sendId = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await sendId('Runtime.evaluate', { expression: expr, returnByValue: true }); return r?.result?.value; };

// resize the window so the saved bounds are distinguishable from defaults
console.log('resizeTo:', await ev('window.resizeTo(1013, 721), innerWidth + "x" + innerHeight'));
await sleep(2500);
console.log('inner size after resize:', await ev('innerWidth + "x" + innerHeight'));
// close normally -> window 'close' handler saves state -> app quits
await ev('window.close(); true');
const code = await Promise.race([new Promise((res) => proc.on('exit', (c) => res(c))), sleep(15000).then(() => 'timeout')]);
console.log('app exit:', code);
const stateFile = path.join(profileDir, 'window-state.json');
console.log('STATE FILE:', fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : 'MISSING');
if (!fs.existsSync(stateFile)) console.log('PROFILE DIR CONTENTS:', fs.readdirSync(profileDir).join(','));
// second launch with the same profile must restore the saved size
if (fs.existsSync(stateFile)) {
  const proc2 = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [
    APP_DIR, `--remote-debugging-port=${CDP_PORT + 1}`,
  ], { env: { ...process.env, LITE_PORT: '0', LITE_USER_DATA: profileDir, LITE_DIST: '/home/hermes/.hermes/cache/scratch/cinny-dist-backup' } });
  proc2.stderr.resume();
  let t2 = null;
  for (let i = 0; i < 40 && !t2; i++) {
    await sleep(400);
    try {
      t2 = (await (await fetch(`http://127.0.0.1:${CDP_PORT + 1}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).find((x) => x.type === 'page');
    } catch { /* not yet */ }
  }
  if (t2) {
    const ws2 = new WebSocket(t2.webSocketDebuggerUrl);
    await new Promise((res) => (ws2.onopen = res));
    const id2 = { n: 0 }; const pend2 = new Map();
    ws2.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend2.has(m.id)) { pend2.get(m.id)(m.result); pend2.delete(m.id); } };
    const r = await new Promise((res) => { const i = ++id2.n; pend2.set(i, res); ws2.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: 'innerWidth + "x" + innerHeight', returnByValue: true } })); });
    console.log('RESTORED inner size:', r?.result?.value);
    ws2.close();
  } else console.log('RESTORED: second launch produced no target');
  proc2.kill('SIGKILL');
}
fs.rmSync(profileDir, { recursive: true, force: true });
process.exit(0);
