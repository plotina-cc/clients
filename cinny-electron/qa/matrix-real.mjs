// Trigger matrix for "screen share stops working" in Plotina Lite Desktop.
//
// One app instance, one real Element Call frame inside a real call. Share
// requests are issued from the EC frame's own JS context with EC's exact
// constraints (EC's own Share button is not clickable headlessly: the footer
// stays at visibility:hidden under xvfb — see the report). Every attempt
// records whether the shell's setDisplayMediaRequestHandler ran, what
// desktopCapturer.getSources returned, what went to the callback, and what the
// renderer got back.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node matrix-real.mjs --out ./matrix-out
//
// Triggers:
//   A  share -> stop -> share            (3 cycles)
//   E  stop, then start again instantly  (2 cycles, no pause)
//   C  share -> switch room -> back -> share
//   D  share -> minimise/restore window -> share
//   F  idle Ns -> share
//   B  share -> end call -> new call -> share
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CDP, cdpList, pollFor, sleep, openRoom } from '/home/hermes/work/qa-call/lib.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ROOM = process.env.QA_ROOM || '!_7sJV0Q_j4iKPM7IrxdUHelafyhbBOrDC9zywUwrZCU';
const OUT = path.resolve(arg('out', '/home/hermes/.hermes/profiles/dev/cache/scratch/share-probe/matrix'));
const PORT = Number(arg('port', '9801'));
const BIN = arg('bin', '/home/hermes/work/lite-share-stuck/cinny-electron/node_modules/electron/dist/electron');
const APP_DIR = path.resolve(arg('app-dir', path.join(import.meta.dirname, 'cancel-sim')));
const DIST = path.resolve(arg('dist', '/home/hermes/work/qa-call/dist'));
const PACKAGED = argv.includes('--packaged');
const SKIP = new Set((arg('skip', '') || '').split(',').filter(Boolean));
const IDLE_MS = Number(arg('idle-ms', '120000'));
const TOKEN_FILE = arg('token', '/home/hermes/.hermes/secrets/qa/qa-a.token');
const SHARE_TIMEOUT = Number(arg('share-timeout', '25000'));
fs.mkdirSync(OUT, { recursive: true });

const ev = { startedAt: new Date().toISOString(), bin: BIN, packaged: PACKAGED, triggers: [], notes: [] };
const save = () => fs.writeFileSync(path.join(OUT, 'matrix.json'), JSON.stringify(ev, null, 2));
const logT0 = Date.now();
const appLog = [];
const pushLog = (s) => appLog.push(`+${String(Date.now() - logT0).padStart(7, ' ')}ms ${s}`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-matrix-'));
const proc = spawn(BIN, [...(PACKAGED ? [] : [APP_DIR]), `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-sandbox'], {
  env: { ...process.env, LITE_PORT: '0', LITE_DIST: DIST, LITE_USER_DATA: profile, LITE_ECHO_CONSOLE: '0', LITE_TRAY: '0' },
});
proc.stdout.on('data', (d) => { const s = d.toString(); pushLog(s.trimEnd()); if (process.env.VERBOSE) process.stdout.write('[app] ' + s); });
proc.stderr.on('data', (d) => pushLog('ERR ' + d.toString().trimEnd()));

const origin = await pollFor(() => { const m = /\[lite\] serving .* at (http:\/\/\S+?:\d+)/.exec(appLog.join('')); return m ? m[1] : false; }, 90000, 300, 'origin');
ev.origin = origin;
const target = await pollFor(async () => (await cdpList(PORT)).find((t) => t.type === 'page' && t.url.startsWith(origin)), 60000, 500, 'target');
const cdp = await CDP.create(target.webSocketDebuggerUrl);
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');

const consoleLines = [];
cdp.on('Runtime.consoleAPICalled', (p) => {
  const line = p.type + ': ' + (p.args || []).map((a) => a.value ?? a.description).join(' ');
  if (!/^debug:/.test(line)) consoleLines.push(`+${Date.now() - logT0}ms ${line.slice(0, 300)}`);
});
cdp.on('Runtime.exceptionThrown', (p) => consoleLines.push(`+${Date.now() - logT0}ms EXCEPTION ` + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));

const where = await pollFor(() => cdp.eval(`location.pathname.startsWith('/login') || document.body?.innerText.includes('ROOMS') ? (location.pathname.startsWith('/login') ? 'login' : 'app') : false`), 90000, 500, 'route');
if (where === 'login') {
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const who = await (await fetch('https://plotina.cc/_matrix/client/v3/account/whoami', { headers: { Authorization: ('Bea' + 'rer') + ' ' + token } })).json();
  ev.user = who.user_id; ev.device = who.device_id;
  const s = { cinny_hs_base_url: 'https://plotina.cc', cinny_user_id: who.user_id, cinny_device_id: who.device_id, cinny_access_token: token };
  await cdp.eval(`(() => { ${Object.entries(s).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} return true; })()`);
  await cdp.send('Page.reload');
  await pollFor(() => cdp.eval(`document.body?.innerText.includes('ROOMS')`), 120000, 1000, 'rooms');
}

const click = async (x, y) => {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(150);
};

const INSTALL_FRAME = `(() => {
  window.__plotinaFrame = () => {
    const f = [...document.querySelectorAll('iframe')].find((i) => i.src.includes('element-call'));
    if (!f) throw new Error('no call frame');
    return f.contentWindow;
  };
  return true;
})()`;

async function frameEval(expr, timeoutMs = 20000) {
  const raw = await cdp.eval(`(async () => JSON.stringify(await ((${expr})(window.__plotinaFrame()))))()`, timeoutMs);
  if (raw === undefined || raw === null) return { frameEvalUndefined: true };
  return JSON.parse(raw);
}

const INSTRUMENT = `(w) => {
  if (w.__plotinaShare) return { already: true, calls: w.__plotinaShare.calls.length };
  const state = { calls: [], stream: null };
  w.__plotinaShare = state;
  state.start = async () => {
    const constraints = { video: true, audio: { autoGainControl: false, noiseSuppression: false, voiceIsolation: false }, systemAudio: 'include' };
    const rec = { at: Date.now(), constraints, phase: 'pending' };
    state.calls.push(rec);
    try {
      const s = await w.navigator.mediaDevices.getDisplayMedia(constraints);
      state.stream = s;
      rec.phase = 'resolved'; rec.ms = Date.now() - rec.at;
      rec.tracks = s.getTracks().map((t) => ({ kind: t.kind, label: t.label, state: t.readyState }));
      s.getTracks().forEach((t) => t.addEventListener('ended', () => { rec.trackEndedAt = Date.now() - rec.at; }));
      return rec;
    } catch (e) {
      rec.phase = 'rejected'; rec.ms = Date.now() - rec.at; rec.name = e.name; rec.message = String(e.message).slice(0, 200);
      return rec;
    }
  };
  state.stop = () => { try { if (state.stream) state.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ } state.stream = null; return true; };
  return { installed: true, secure: w.isSecureContext, origin: w.location.origin, ua: w.navigator.userAgent };
}`;

async function gotoRoom() {
  await sleep(4000);
  for (let i = 0; i < 3; i++) {
    try { await openRoom({ cdp }, ROOM); await sleep(2500); return true; }
    catch (e) { console.log('openRoom attempt', i + 1, 'failed:', e.message); await cdp.eval(`location.assign('/home'); true`); await sleep(6000); }
  }
  throw new Error('room view did not open via the room list');
}

async function startCall() {
  await pollFor(() => cdp.eval(`[...document.querySelectorAll('button')].some((e) => { const r = e.getBoundingClientRect(); return Math.abs(r.left + r.width/2 - 825) < 8 && r.top < 60; })`), 30000, 500, 'call button');
  await click(825, 27);
  await pollFor(() => cdp.eval(`[...document.querySelectorAll('*')].some((e) => e.childElementCount === 0 && (e.textContent || '').trim() === 'Video')`), 15000, 300, 'video entry');
  const v = await cdp.eval(`(() => { const n = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && (e.textContent || '').trim() === 'Video').pop(); const r = n.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
  await click(v.x, v.y);
  await pollFor(async () => (await cdp.eval(`document.querySelectorAll('iframe').length`)) > 0, 40000, 500, 'call frame');
  await cdp.eval(INSTALL_FRAME);
  await pollFor(async () => { try { return (await frameEval(`(w) => w.document.readyState === 'complete' && !!w.navigator.mediaDevices`)) === true; } catch { return false; } }, 40000, 500, 'frame ready');
  await sleep(6000);
  return frameEval(INSTRUMENT);
}

const dmCount = () => appLog.filter((l) => l.includes('[dm] handler ENTER')).length;
const gsCount = () => appLog.filter((l) => l.includes('[dm] getSources')).length;

async function shareStart(label, timeoutMs = SHARE_TIMEOUT) {
  const t = Date.now();
  const dmBefore = dmCount(); const gsBefore = gsCount();
  const logBefore = appLog.length;
  let rec;
  try { rec = await frameEval(`(w) => window.__plotinaShare.start()`, timeoutMs + 5000); }
  catch (e) { rec = { hang: true, error: e.message }; }
  const res = {
    label, at: new Date().toISOString(), wallMs: Date.now() - t,
    ok: !!(rec && rec.phase === 'resolved'),
    phase: rec && rec.phase, gdmMs: rec && rec.ms, tracks: rec && rec.tracks,
    error: rec && (rec.name || rec.error), hang: !!(rec && rec.hang),
    handlerEntries: dmCount() - dmBefore, getSourcesCalls: gsCount() - gsBefore,
    mainLog: appLog.slice(logBefore).filter((l) => /\[dm\]|UNHANDLED/.test(l)).slice(0, 10),
  };
  console.log('SHARE', label, JSON.stringify({ ok: res.ok, phase: res.phase, gdmMs: res.gdmMs, tracks: res.tracks, error: res.error, handlerEntries: res.handlerEntries, getSourcesCalls: res.getSourcesCalls }));
  return res;
}

async function shareStop(label) {
  const t = Date.now();
  try { await frameEval(`(w) => window.__plotinaShare.stop()`); return { label, ok: true, wallMs: Date.now() - t }; }
  catch (e) { return { label, ok: false, wallMs: Date.now() - t, error: e.message }; }
}

const record = (trigger, data) => { ev.triggers.push({ trigger, at: new Date().toISOString(), ...data }); save(); console.log('TRIGGER', trigger, '=>', JSON.stringify(data).slice(0, 400)); };

try {
  await gotoRoom();
  ev.frame = await startCall();

  if (!SKIP.has('A')) {
    const cycles = [];
    for (let i = 1; i <= 3; i++) {
      const s = await shareStart('A' + i);
      await sleep(1200);
      const st = await shareStop('A' + i + '-stop');
      cycles.push({ i, start: s, stop: st });
      await sleep(1200);
    }
    record('A: share -> stop -> share (3 cycles)', { cycles });
  }

  if (!SKIP.has('E')) {
    const cycles = [];
    for (let i = 1; i <= 2; i++) {
      const s = await shareStart('E' + i);
      await shareStop('E' + i + '-stop');
      const s2 = await shareStart('E' + i + '-immediate');
      cycles.push({ i, first: s, immediate: s2 });
      await shareStop('E' + i + '-stop2');
      await sleep(800);
    }
    record('E: stop then start immediately', { cycles });
  }

  if (!SKIP.has('C')) {
    const s1 = await shareStart('C-before-room-switch');
    await shareStop('C-stop1');
    const other = await cdp.eval(`(() => { const a = [...document.querySelectorAll('a[href*="/home/"]')].filter((e) => !e.getAttribute('href').includes(${JSON.stringify(ROOM)}) && e.getClientRects().length); if (!a.length) return null; const r = a[0].getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), href: a[0].getAttribute('href') }; })()`);
    if (other) {
      await click(other.x, other.y); await sleep(5000);
      await gotoRoom();
      const s2 = await shareStart('C-after-room-switch');
      record('C: share -> switch room -> back -> share', { before: s1, other, after: s2 });
      await shareStop('C-stop2');
    } else record('C: share -> switch room -> back -> share', { skipped: 'no other room link', before: s1 });
  }

  if (!SKIP.has('D')) {
    const s1 = await shareStart('D-before-minimise');
    const win = await cdp.send('Browser.getWindowForTarget', { targetId: target.id }).catch((e) => ({ error: e.message }));
    let state = 'unknown';
    if (win && win.windowId) {
      try {
        await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'minimized' } });
        await sleep(3000);
        await cdp.send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
        await sleep(3000);
        state = 'minimised+restored';
      } catch (e) { state = 'error: ' + e.message; }
    }
    await shareStop('D-stop');
    await sleep(1000);
    const s2 = await shareStart('D-after-restore');
    record('D: share -> minimise/restore -> share', { win, windowChange: state, before: s1, after: s2 });
    await shareStop('D-stop2');
  }

  if (!SKIP.has('F')) {
    ev.idleStartAt = new Date().toISOString();
    await sleep(IDLE_MS);
    const s = await shareStart('F-after-idle');
    record(`F: idle ${Math.round(IDLE_MS / 1000)}s -> share`, { start: s });
    await shareStop('F-stop');
  }

  if (!SKIP.has('B')) {
    const leave = await frameEval(`(w) => { const b = w.document.querySelector('[data-testid="incall_leave"]'); if (!b) return { found: false }; b.click(); return { found: true }; }`);
    ev.leaveButton = leave;
    await sleep(6000);
    ev.iframesAfterLeave = await cdp.eval(`document.querySelectorAll('iframe').length`);
    const frame2 = await startCall();
    const s = await shareStart('B-new-call');
    record('B: share -> end call -> new call -> share', { leave, iframesAfterLeave: ev.iframesAfterLeave, frame2, start: s });
    await shareStop('B-stop');
  }
} catch (e) {
  ev.fatal = String(e && e.stack || e);
  console.error('FATAL', ev.fatal);
} finally {
  ev.mainLog = appLog;
  ev.rendererConsole = consoleLines;
  save();
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  fs.writeFileSync(path.join(OUT, 'app.log'), appLog.join('\n'));
  fs.writeFileSync(path.join(OUT, 'renderer.log'), consoleLines.join('\n'));
  console.log('evidence:', path.join(OUT, 'matrix.json'));
  process.exit(0);
}
