// Diagnostic: what does the token-carrying child page actually render?
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const CDP_PORT = 14466;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-child-'));
const log = [];
const proc = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [
  APP_DIR, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run',
], { env: { ...process.env, LITE_PORT: '0', LITE_USER_DATA: profileDir, LITE_DIST: '/home/hermes/.hermes/cache/scratch/cinny-dist-backup' } });
proc.stdout.on('data', (d) => { log.push(d.toString()); process.stdout.write('[app] ' + d); });
proc.stderr.resume();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).filter((t) => t.type === 'page');
let ORIGIN = null;
for (let i = 0; i < 60 && !ORIGIN; i++) { await sleep(300); const m = /at (http:\/\/\S+?:\d+)/.exec(log.join('')); if (m) ORIGIN = m[1]; }
console.log('origin', ORIGIN);

class C { constructor(u){ this.ws = new WebSocket(u); this.id = 0; this.p = new Map();
  this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { this.p.get(m.id)(m); this.p.delete(m.id); } }; }
  async open(){ if (this.ws.readyState !== 1) await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); return this; }
  send(method, params = {}) { return new Promise((res) => { const id = ++this.id; this.p.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const m = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return m.result?.result?.value ?? ('EXC:' + JSON.stringify(m.result?.exceptionDetails?.text || m.result?.exceptionDetails?.exception?.description)); }
}
let main;
try {
  let t = null; for (let i = 0; i < 60 && !t; i++) { t = (await list()).find((x) => x.url.startsWith(ORIGIN)); if (!t) await sleep(300); }
  main = await new C(t.webSocketDebuggerUrl).open();
  await sleep(2500);
  await main.ev(`(window.open('/login/plotina.cc/?loginToken=DBG_CHILD', '_blank', 'width=500,height=700'), true)`);
  let ct = null;
  for (let i = 0; i < 40 && !ct; i++) { await sleep(200); ct = (await list()).find((x) => x.url.includes('DBG_CHILD')); }
  if (!ct) { console.log('NO CHILD'); }
  else {
    const child = await new C(ct.webSocketDebuggerUrl).open();
    await child.send('Runtime.enable');
    child.ws.addEventListener?.('message', () => {});
    for (const at of [800, 800, 1500, 1500, 2000]) {
      await sleep(at);
      const snap = await child.ev(`JSON.stringify({
        url: location.href,
        ready: document.readyState,
        rootKids: document.getElementById('root')?.childElementCount ?? -1,
        bodyLen: document.body?.innerText?.length ?? -1,
        bodyStart: (document.body?.innerText || '').slice(0, 120),
        hasOpener: !!window.opener,
      })`);
      console.log('CHILD SNAPSHOT:', snap);
    }
  }
} catch (e) { console.log('DIAG ERROR', e.message); }
proc.kill('SIGKILL');
fs.rmSync(profileDir, { recursive: true, force: true });
console.log('CHILD_DIAG_DONE');
process.exit(0);
