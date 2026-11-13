// Live proof that screen sharing keeps working in one app run: repeated
// start/stop cycles, an injected cancelled-picker failure in the middle (the
// old defect), idle, window minimise/restore and a renderer reload.
//
//   SIM_CANCEL_AT=4 xvfb-run -a -s "-screen 0 1400x900x24" \
//     node qa/live-proof.mjs --dist ./qa/probe-dist --out /tmp/live-proof
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = path.resolve(arg('app-dir', './qa/cancel-sim'));
const BIN = arg('bin', path.resolve('node_modules/electron/dist/electron'));
const DIST = path.resolve(arg('dist', './qa/probe-dist'));
const OUT = path.resolve(arg('out', './qa/live-proof-out'));
const PORT = Number(arg('port', String(15500 + Math.floor(Math.random() * 300))));
const IDLE_MS = Number(arg('idle-ms', '60000'));
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const ev = { startedAt: new Date().toISOString(), steps: [], cancelAt: process.env.SIM_CANCEL_AT || null };
const save = () => fs.writeFileSync(path.join(OUT, 'live-proof.json'), JSON.stringify({ ...ev, mainLog: log }, null, 2));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-live-'));
const proc = spawn(BIN, [APP_DIR, `--remote-debugging-port=${PORT}`, '--no-first-run'], {
  env: { ...process.env, LITE_PORT: '0', LITE_DIST: DIST, LITE_USER_DATA: profile, LITE_ECHO_CONSOLE: '0', LITE_TRAY: '0' },
});
proc.stdout.on('data', (d) => log.push(d.toString().trimEnd()));
proc.stderr.on('data', (d) => log.push('ERR ' + d.toString().trimEnd()));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result); } }; }
  static async open(url) { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); }); return new CDP(ws); }
  send(method, params = {}, timeoutMs = 60000) {
    return new Promise((res, rej) => { const id = ++this.id;
      const timer = setTimeout(() => { if (this.pending.delete(id)) rej(Object.assign(new Error('timeout ' + method), { timeout: true })); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
}
const list = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json());
async function pollFor(fn, ms, why, every = 300) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e.message; } await sleep(every); }
  throw new Error(`timed out: ${why}${last ? ' (' + last + ')' : ''}`);
}
async function attach(origin) {
  const t = await pollFor(async () => (await list()).find((x) => x.type === 'page' && x.url.startsWith(origin)), 30000, 'page target');
  const cdp = await CDP.open(t.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await pollFor(() => cdp.eval('typeof window.__probe'), 20000, 'probe page');
  return { cdp, targetId: t.id };
}

async function share(cdp, label) {
  const t0 = Date.now();
  let r;
  try { r = await cdp.eval('window.__probe({mode:"ec"})', 40000); } catch (e) { r = { hang: true, error: e.message }; }
  const step = { label, wallMs: Date.now() - t0, ok: !!(r && r.ok), name: r && r.name, error: r && (r.message || r.error), tracks: r && r.tracks, paintedPixels: r && r.paintedPixels };
  ev.steps.push(step); save();
  console.log('STEP', label, JSON.stringify(step));
  return step;
}

try {
  const origin = await pollFor(() => { const m = /\[lite\] serving .* at (http:\/\/\S+?:\d+)/.exec(log.join('\n')); return m ? m[1] : false; }, 40000, 'origin');
  ev.origin = origin;
  let { cdp, targetId } = await attach(origin);

  for (let i = 1; i <= 3; i++) await share(cdp, `cycle-${i}`);

  // cancel is injected here by SIM_CANCEL_AT (getSources call #4)
  const canceled = await share(cdp, 'injected-cancel');
  ev.cancelObserved = { ok: canceled.ok, name: canceled.name };
  await share(cdp, 'after-cancel-1');
  await share(cdp, 'after-cancel-2');

  ev.idleMs = IDLE_MS;
  await sleep(IDLE_MS);
  await share(cdp, `after-idle-${Math.round(IDLE_MS / 1000)}s`);

  const win = await cdp.send('Browser.getWindowForTarget', { targetId }).catch((e) => ({ error: e.message }));
  if (win && win.windowId) {
    try {
      await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'minimized' } });
      await sleep(2500);
      await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      await sleep(2500);
      ev.minimised = true;
    } catch (e) { ev.minimised = 'error: ' + e.message; }
  }
  await share(cdp, 'after-minimise-restore');

  // renderer reload: a fresh page session, closest shell-level analogue of a new call
  await cdp.send('Page.enable');
  await cdp.send('Page.reload');
  await sleep(3000);
  ({ cdp, targetId } = await attach(origin));
  await share(cdp, 'after-reload');
  await share(cdp, 'after-reload-2');
} catch (e) {
  ev.fatal = String(e && e.stack || e);
  console.error('FATAL', ev.fatal);
} finally {
  save();
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  const okCount = ev.steps.filter((s) => s.ok).length;
  console.log(`steps: ${okCount}/${ev.steps.length} ok, evidence: ${path.join(OUT, 'live-proof.json')}`);
  process.exit(ev.fatal ? 2 : 0);
}
