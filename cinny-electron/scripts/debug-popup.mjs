// Debug: why doesn't window.open create a child target?
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const PORT = 44548, CDP_PORT = 9241;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-dbg-'));
const proc = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [
  APP_DIR, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run',
], { env: { ...process.env, LITE_USER_DATA: profileDir, LITE_ECHO_CONSOLE: '1' } });
proc.stdout.on('data', (d) => process.stdout.write('[app] ' + d));
proc.stderr.on('data', (d) => process.stdout.write('[app-err] ' + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => { try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { return []; } };

let ws, id = 0;
const pend = new Map();
async function connect() {
  let t;
  for (let i = 0; i < 60; i++) { t = (await list()).find((x) => x.type === 'page'); if (t) break; await sleep(500); }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
}
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJS = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result;
};

await connect();
await sleep(4000);
console.log('START TARGETS:', JSON.stringify(await list(), null, 1).slice(0, 800));
console.log('location:', (await evalJS('location.href')).value);
const r = await evalJS(`(() => { try { const w = window.open('/login/plotina.cc/?loginToken=DBG_1', '_blank', 'width=500,height=700'); return w ? 'window-proxy' : 'null'; } catch (e) { return 'throw:' + e.message; } })()`);
console.log('window.open result:', JSON.stringify(r));
const seen = new Set();
for (let i = 0; i < 16; i++) {
  const cur = await list();
  const key = cur.map((t) => `${t.type} ${t.url}`).sort().join(' | ');
  if (!seen.has(key)) { seen.add(key); console.log(`T+${i * 250}ms:`, key); }
  await sleep(250);
}
const after = await list();
console.log('AFTER:', after.map((t) => `${t.type} ${t.url}`).join(' | '));
proc.kill('SIGTERM');
await sleep(1000); proc.kill('SIGKILL');
fs.rmSync(profileDir, { recursive: true, force: true });
console.log('DBG_DONE');
