// Diagnostic: does an Electron window.open child keep a real opener link
// (window.opener non-null + postMessage to opener delivered to the parent)?
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const CDP_PORT = 14455;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-opener-'));
const log = [];
const proc = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [
  APP_DIR, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run',
], { env: { ...process.env, LITE_PORT: '0', LITE_USER_DATA: profileDir } });
proc.stdout.on('data', (d) => log.push(d.toString()));
proc.stderr.resume();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).filter((t) => t.type === 'page');
let ORIGIN = null;
for (let i = 0; i < 60 && !ORIGIN; i++) { await sleep(300); const m = /at (http:\/\/\S+?:\d+)/.exec(log.join('')); if (m) ORIGIN = m[1]; }
console.log('origin', ORIGIN);

class C { constructor(u){ this.ws = new WebSocket(u); this.id = 0; this.p = new Map();
  this.ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.p.has(m.id)) { this.p.get(m.id)(m.result); this.p.delete(m.id); } }; }
  async open(){ if (this.ws.readyState !== 1) await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); return this; }
  send(method, params = {}) { return new Promise((res) => { const id = ++this.id; this.p.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.value; }
}
let main;
try {
  let t = null; for (let i = 0; i < 60 && !t; i++) { t = (await list()).find((x) => x.url.startsWith(ORIGIN)); if (!t) await sleep(300); }
  main = await new C(t.webSocketDebuggerUrl).open();
  await sleep(3000); // let the login app mount its listeners
  // parent: neutral probe listener + window without a token (no auto-close)
  await main.ev(`window.__probe = []; window.addEventListener('message', (e) => { if (e.data && e.data.__probe) window.__probe.push([e.origin, e.data.__probe]); }); true`);
  await main.ev(`(window.open('/login/plotina.cc/?openerprobe=1', '_blank', 'width=500,height=700'), true)`);
  let ct = null;
  for (let i = 0; i < 40 && !ct; i++) { await sleep(250); ct = (await list()).find((x) => x.url.includes('openerprobe')); }
  if (!ct) { console.log('RESULT: no child page target'); }
  else {
    const child = await new C(ct.webSocketDebuggerUrl).open();
    await sleep(1500); // let child app boot (it will run the patched opener branch harmlessly)
    const openerInfo = await child.ev(`({
      hasOpener: !!window.opener,
      openerLocationAccess: (() => { try { return window.opener ? window.opener.location.href : null; } catch (e) { return 'blocked:' + e.name; } })(),
    })`);
    console.log('child opener info:', JSON.stringify(openerInfo));
    await child.ev(`(window.opener && window.opener.postMessage({ __probe: 'from-child' }, window.location.origin), true)`);
    await sleep(1000);
    const probe = await main.ev(`window.__probe`);
    console.log('parent received:', JSON.stringify(probe));
    await child.send('Page.close').catch(() => {});
  }
} catch (e) { console.log('DIAG ERROR', e.message); }
proc.kill('SIGKILL');
fs.rmSync(profileDir, { recursive: true, force: true });
console.log('OPENER_DIAG_DONE');
process.exit(0);
