// Live screen-share probe for the Plotina Lite Electron shell.
// Launches the shell (source or packaged), then runs N start->stop share
// cycles in ONE app run through the renderer's getDisplayMedia, recording what
// each cycle returns plus the main-process log and the child process table.
//
//   xvfb-run -a -s "-screen 0 1400x900x24" \
//     node run-share-probe.mjs --cycles 3 --out /tmp/probe-out
//
// --bin       electron binary (default: <app>/node_modules/electron/dist/electron)
// --app-dir   app directory to load when running from source
// --dist      directory served as the web app (default: ./dist next to this script)
// --cycles    share cycles per app run (default 3)
// --audio     request audio as well (Element Call does)
// --out       evidence directory
'use strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const APP_DIR = arg('app-dir', '/home/hermes/work/lite-share-stuck/cinny-electron');
const BIN = arg('bin', path.join(APP_DIR, 'node_modules/electron/dist/electron'));
const PACKAGED = !BIN.startsWith(path.join(APP_DIR, 'node_modules'));
const DIST = path.resolve(arg('dist', path.join(import.meta.dirname, 'dist')));
const CYCLES = Number(arg('cycles', '3'));
const WANT_AUDIO = argv.includes('--audio');
const MODE = arg('mode', 'video');
const OUT = path.resolve(arg('out', path.join(import.meta.dirname, 'out')));
const CDP_PORT = Number(arg('cdp-port', String(15000 + Math.floor(Math.random() * 2000))));

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
const notes = [];

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      } else if (m.method) (this.listeners.get(m.method) || []).forEach((cb) => cb(m.params));
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    return new CDP(ws);
  }
  send(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(Object.assign(new Error('timeout ' + method), { timeout: true })); }, timeoutMs);
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(cb); }
  async eval(expression, timeoutMs = 25000) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) return { evalError: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  }
}

const cdpList = async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json());
async function pollFor(fn, timeout, why, interval = 400) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${why}${last ? ' (' + last + ')' : ''}`);
}
function childTable(pid) {
  const out = spawnSyncSafe('ps', ['-o', 'pid,ppid,rss,etime,args', '--forest', '-g', '0']);
  return out.split('\n').filter((l) => l.includes(String(pid)) || /gpu-process|utility|zygote|renderer|video_capture|audio/.test(l));
}
function spawnSyncSafe(cmd, args) {
  const r = spawn(cmd, args, { encoding: 'utf8' });
  let s = '';
  r.stdout.on('data', (d) => { s += d; });
  r.stderr.on('data', (d) => { s += d; });
  return { toString: () => s };
}
async function psOf(pid) {
  return await new Promise((res) => {
    const p = spawn('ps', ['-o', 'pid,ppid,pcpu,rss,args', '-g', String(pid)]);
    let s = '';
    p.stdout.on('data', (d) => { s += d; });
    p.on('close', () => res(s));
  });
}

const evidence = { startedAt: new Date().toISOString(), bin: BIN, packaged: PACKAGED, dist: DIST, cycles: [], notes };
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-share-probe-'));
const args = [
  ...(PACKAGED ? [] : [APP_DIR]),
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-first-run',
];
const proc = spawn(BIN, args, {
  env: { ...process.env, LITE_PORT: '0', LITE_DIST: DIST, LITE_USER_DATA: profileDir, LITE_ECHO_CONSOLE: '1', LITE_TRAY: '0' },
});
proc.stdout.on('data', (d) => { const s = d.toString(); logLines.push(s); process.stdout.write('[app] ' + s); });
proc.stderr.on('data', (d) => { const s = d.toString(); logLines.push(s); process.stderr.write('[app!] ' + s); });
proc.on('exit', (code) => console.log('[app] exited', code));

let ok = false;
try {
  const ORIGIN = await pollFor(() => {
    const m = /\[lite\] serving .* at (http:\/\/\S+?:\d+)/.exec(logLines.join(''));
    return m ? m[1] : false;
  }, 30000, 'app origin line');
  evidence.origin = ORIGIN;
  const target = await pollFor(async () => (await cdpList()).find((t) => t.type === 'page' && t.url.startsWith(ORIGIN)), 30000, 'page target');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  const consoleLines = [];
  cdp.on('Runtime.consoleAPICalled', (p) => consoleLines.push((p.args || []).map((a) => a.value ?? a.description).join(' ')));
  cdp.on('Runtime.exceptionThrown', (p) => consoleLines.push('EXCEPTION ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));
  await pollFor(() => cdp.eval('typeof window.__probe'), 20000, 'probe page');

  evidence.psBefore = await psOf(proc.pid);
  for (let i = 1; i <= CYCLES; i++) {
    const expr = `window.__probe(${JSON.stringify({ audio: WANT_AUDIO, mode: MODE })})`;
    const t0 = Date.now();
    let r;
    try {
      r = await cdp.eval(expr, 30000);
    } catch (e) {
      r = { hang: true, error: e.message };
    }
    const cycle = { cycle: i, wallMs: Date.now() - t0, result: r };
    evidence.cycles.push(cycle);
    console.log(`CYCLE ${i}: ${JSON.stringify(r)}`);
    evidence[`psAfterCycle${i}`] = await psOf(proc.pid);
  }
  evidence.rendererConsole = consoleLines;
  evidence.mainLog = logLines.join('');
  await sleep(500);
  ok = evidence.cycles.every((c) => c.result && c.result.ok === true);
  evidence.allCyclesSucceeded = ok;
  if (!ok) notes.push('at least one share cycle failed');
} catch (e) {
  evidence.fatal = String(e && e.stack || e);
  console.error('FATAL', evidence.fatal);
} finally {
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  fs.writeFileSync(path.join(OUT, 'share-probe.json'), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT, 'app.log'), logLines.join(''));
  console.log('evidence:', path.join(OUT, 'share-probe.json'));
  console.log('VERDICT:', evidence.fatal ? 'ERROR' : ok ? 'ALL_CYCLES_OK' : 'STUCK');
  process.exit(evidence.fatal ? 2 : ok ? 0 : 1);
}
