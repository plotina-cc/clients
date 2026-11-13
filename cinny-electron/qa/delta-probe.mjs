// Measures the recovery window (Δ) after a display-capture request fails.
// Launches the shell (optionally through the cancel-sim wrapper), runs one
// normal share, then a share whose getSources fails (cancelled portal picker),
// then retries getDisplayMedia every RETRY_EVERY ms until one succeeds and
// reports Δ = success - failure.
//
//   SIM_CANCEL_AT=2 xvfb-run -a -s "-screen 0 1400x900x24" \
//     node delta-probe.mjs --app-dir ./cancel-sim --cycles 1 --out out-delta
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = path.resolve(arg('app-dir', '/home/hermes/work/lite-share-stuck/cinny-electron'));
const BIN = arg('bin', '/home/hermes/work/lite-share-stuck/cinny-electron/node_modules/electron/dist/electron');
const DIST = path.resolve(arg('dist', path.join(import.meta.dirname, 'dist')));
const OUT = path.resolve(arg('out', path.join(import.meta.dirname, 'out-delta')));
const CDP_PORT = Number(arg('cdp-port', String(15400 + Math.floor(Math.random() * 400))));
const RETRY_EVERY = Number(arg('retry-every', '3000'));
const RETRY_MAX = Number(arg('retry-max', '40')); // 40 * 3s = 2 min of retries
const ATTEMPT_TIMEOUT = Number(arg('attempt-timeout', '20000'));

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result); } };
  }
  static async connect(url) { const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new CDP(ws); }
  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => { const id = ++this.id;
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(Object.assign(new Error('timeout ' + method), { timeout: true })); }, timeoutMs);
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression, timeoutMs = 25000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) return { evalError: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  }
}
const cdpList = async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json());
async function pollFor(fn, timeout, why, interval = 300) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e.message; } await sleep(interval); }
  throw new Error(`timed out waiting for ${why}${last ? ' (' + last + ')' : ''}`);
}

const ev = { startedAt: new Date().toISOString(), appDir: APP_DIR, attempts: [], retries: [] };
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-delta-'));
const proc = spawn(BIN, [APP_DIR, `--remote-debugging-port=${CDP_PORT}`, '--no-first-run'], {
  env: { ...process.env, LITE_PORT: '0', LITE_DIST: DIST, LITE_USER_DATA: profile, LITE_ECHO_CONSOLE: '1', LITE_TRAY: '0' },
});
proc.stdout.on('data', (d) => { const s = d.toString(); logLines.push(s); process.stdout.write('[app] ' + s); });
proc.stderr.on('data', (d) => { const s = d.toString(); logLines.push(s); });
proc.on('exit', (c) => console.log('[app] exited', c));

async function attempt(cdp, tag) {
  const t0 = Date.now();
  let r;
  try { r = await cdp.eval('window.__probe({mode:"video"})', ATTEMPT_TIMEOUT); }
  catch (e) { r = { hang: true, error: e.message }; }
  const rec = { tag, at: Date.now(), wallMs: Date.now() - t0, result: r };
  ev.attempts.push(rec);
  console.log(`ATTEMPT ${tag}: ${JSON.stringify(r)} (${rec.wallMs} ms)`);
  return rec;
}

try {
  const ORIGIN = await pollFor(() => { const m = /\[lite\] serving .* at (http:\/\/\S+?:\d+)/.exec(logLines.join('')); return m ? m[1] : false; }, 30000, 'origin');
  const target = await pollFor(async () => (await cdpList()).find((t) => t.type === 'page' && t.url.startsWith(ORIGIN)), 30000, 'target page');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await pollFor(() => cdp.eval('typeof window.__probe'), 20000, 'probe page');

  await attempt(cdp, 'baseline');
  const failed = await attempt(cdp, 'failing');
  ev.failureAt = Date.now();
  const failTs = Date.now();
  const wanted = Number(process.env.RETRY_MAX || RETRY_MAX);
  for (let i = 1; i <= wanted; i++) {
    await sleep(RETRY_EVERY);
    const r = await attempt(cdp, 'retry' + i);
    ev.retries.push({ i, sinceFailureMs: Date.now() - failTs, ok: !!(r.result && r.result.ok), result: r.result });
    if (r.result && r.result.ok) { ev.deltaMs = Date.now() - failTs; break; }
  }
  ev.failedAttempt = failed;
  ev.mainLog = logLines.join('');
} catch (e) {
  ev.fatal = String(e && e.stack || e);
  console.error('FATAL', ev.fatal);
} finally {
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  fs.writeFileSync(path.join(OUT, 'delta.json'), JSON.stringify(ev, null, 2));
  fs.writeFileSync(path.join(OUT, 'app.log'), logLines.join(''));
  console.log('DELTA_MS:', ev.deltaMs, 'evidence:', path.join(OUT, 'delta.json'));
  process.exit(0);
}
