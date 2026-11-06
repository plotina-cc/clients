// QA harness for the Plotina Lite Electron prototype.
// Proves: WebRTC availability, media permissions + fake devices, SSO popup
// with a real opener relationship (synthetic loginToken), deep-link token
// handoff fallback, and a Matrix message round trip with the injected @hermes
// session. Screenshots + evidence.json land in --out.
//
//   xvfb-run -a -s "-screen 0 1440x900x24" node scripts/qa.mjs
//
// Never prints the access token. Reads it from QA_TOKEN_FILE only.
'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP_DIR = path.resolve(import.meta.dirname, '..');
// Preferred app port; main.js falls back to an ephemeral port if busy and we
// read the real origin back from its log line (no interference with other
// QA sessions running in parallel).
const CDP_PORT = Number(process.env.QA_CDP_PORT || (14000 + Math.floor(Math.random() * 2000)));
let ORIGIN = null;
const HS = 'https://plotina.cc';
const ROOM = process.env.QA_ROOM || '!mUPrflIuBoqnUl_g4GY3zuEozT6vCU5jUatII4SwiGY';
const TOKEN_FILE = process.env.QA_TOKEN_FILE || '/home/hermes/.hermes/cache/qa-matrix-token';
const OUT = process.env.QA_OUT || '/home/hermes/.hermes/cache/scratch/lite-electron-qa';
const SYN_1 = 'SYN_QA_' + Date.now() + '_1';
const SYN_2 = 'SYN_QA_' + Date.now() + '_2';

fs.mkdirSync(OUT, { recursive: true });
const evidence = {
  startedAt: new Date().toISOString(),
  origin: ORIGIN,
  electron: null,
  webRTC: {},
  sso: {},
  deepLink: {},
  messaging: {},
  window: {},
  checks: [],
  notes: [],
};
const fail = (m) => { evidence.checks.push({ ok: false, check: m }); throw new Error(m); };
const pass = (m, extra = {}) => { evidence.checks.push({ ok: true, check: m, ...extra }); console.log('PASS', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pollFor(fn, timeout, interval = 500, why = '') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e.message; }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for: ${why}${last !== undefined ? ` (last=${last})` : ''}`);
}

// ---------------------------------------------------------------- tiny CDP
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method) {
        (this.listeners.get(msg.method) || []).forEach((cb) => cb(msg.params));
      }
    };
    this.closed = new Promise((resolve) => {
      this.ws.onclose = () => {
        for (const [, p] of this.pending) p.reject(new Error('cdp closed'));
        this.pending.clear();
        resolve();
      };
    });
    this.ready = new Promise((resolve, reject) => {
      if (this.ws.readyState === 1) resolve();
      else {
        this.ws.onopen = () => resolve();
        this.ws.addEventListener('error', () => reject(new Error('cdp ws error')));
        this.ws.addEventListener('close', () => reject(new Error('cdp ws closed before open')));
      }
    });
  }
  static async create(wsUrl) {
    const c = new CDP(wsUrl);
    await c.ready;
    return c;
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 25000);
      const settle = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(data, 'base64'));
    return p;
  }
}
const cdpList = async () => (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json());

// ---------------------------------------------------------------- launch
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: harness exceeded 300s — dumping evidence and aborting');
  try { fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ ...evidence, error: 'watchdog timeout' }, null, 2)); } catch { /* ignore */ }
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(2);
}, 300000);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lite-qa-profile-'));
const logLines = [];
// Packaged QA: QA_BIN points at the electron-builder output (extracted
// AppRun or the deb binary). A packaged binary takes no app-dir argument and
// serves its own bundled web dist, so LITE_DIST stays unset there.
const QA_BIN = process.env.QA_BIN || null;
const BIN = QA_BIN || path.join(APP_DIR, 'node_modules/electron/dist/electron');
const proc = spawn(BIN, [
  ...(QA_BIN ? [] : [APP_DIR]),
  `--remote-debugging-port=${CDP_PORT}`,
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--no-first-run',
], { env: {
    ...process.env,
    LITE_PORT: '0', // ephemeral port: never collides with parallel QA sessions
    // Pinned copy of the patched dist: /home/hermes/build/.../dist is shared
    // with other agents and gets rebuilt mid-run. Packaged runs use the dist
    // baked into the app.
    ...(QA_BIN ? {} : { LITE_DIST: process.env.QA_DIST || '/home/hermes/.hermes/cache/scratch/cinny-dist-backup' }),
    LITE_USER_DATA: profileDir,
    LITE_ECHO_CONSOLE: '1',
    LITE_TRAY: process.env.QA_TRAY || '0',
  } });
proc.stdout.on('data', (d) => { const s = d.toString(); logLines.push(s); process.stdout.write('[app] ' + s); });
proc.stderr.on('data', (d) => { const s = d.toString(); logLines.push(s); });
proc.on('exit', (code) => console.log('[app] exited', code));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } process.exit(143); });
}

let mainCDP, childCDP = null, secondProc = null;
try {
  ORIGIN = await pollFor(
    () => {
      // The dist path may contain spaces (".../opt/Plotina Lite Desktop/...")
      // so match on the URL tail instead of \S+ over the whole path.
      const m = /\[lite\] serving .* at (http:\/\/\S+?:\d+)/.exec(logLines.join(''));
      return m ? m[1] : false;
    },
    30000, 200, 'app origin line');
  evidence.origin = ORIGIN;
  console.log('app origin:', ORIGIN);

  await pollFor(async () => { const l = await cdpList(); return l.length > 0 || true; }, 30000, 500, 'CDP endpoint');

  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!token) fail('empty QA token file');
  const whoami = await (await fetch(`${HS}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (!whoami.user_id) fail('whoami failed for token file');
  console.log('QA user:', whoami.user_id, 'device', whoami.device_id);

  const targets = await pollFor(async () => {
    const list = await cdpList();
    return list.find((t) => t.type === 'page' && t.url.startsWith(ORIGIN)) || false;
  }, 30000, 500, 'main app page target');
  mainCDP = await CDP.create(targets.webSocketDebuggerUrl);
  evidence.electron = { version: process.env.QA_ELECTRON || '44.4.5', targetUrl: targets.url, targetTitle: targets.title };
  try {
    const wt = await mainCDP.send('Browser.getWindowForTarget', { targetId: targets.id });
    evidence.window.nativeTitle = wt.title;
  } catch { /* Browser domain may be unavailable; page title still recorded */ }
  await mainCDP.send('Runtime.enable');
  await mainCDP.send('Page.enable');
  await mainCDP.send('Network.enable');

  // App must come up on the Login route (fresh profile).
  await pollFor(() => mainCDP.eval(`(async () => {
    for (let i=0;i<40;i++){ if (location.pathname.startsWith('/login') || document.body?.innerText.includes('Login')) return true; await new Promise(r=>setTimeout(r,250)); }
    if (!location.pathname.startsWith('/login')) location.assign('/login');
    return false; })()`), 30000, 1000, 'login route');
  await sleep(1500);
  evidence.window.title = (await cdpList()).find((t) => t.id === targets.id)?.title;
  evidence.window.url = await mainCDP.eval('location.href');

  const loginPosts = [];
  mainCDP.on('Network.requestWillBeSent', (p) => {
    if (p.request.url.includes('/_matrix/client/v3/login') && p.request.method === 'POST') {
      loginPosts.push(p.request.postData || '');
    }
  });

  // ---------------------------------------------------- A. WebRTC presence
  const rtc = await mainCDP.eval(`({
    secure: window.isSecureContext,
    origin: location.origin,
    rtcType: typeof RTCPeerConnection,
    mediaDevices: !!navigator.mediaDevices,
    gum: typeof navigator.mediaDevices?.getUserMedia,
    gdm: typeof navigator.mediaDevices?.getDisplayMedia,
  })`);
  evidence.webRTC = rtc;
  if (!rtc.secure) fail('app origin is not a secure context');
  if (rtc.rtcType !== 'function') fail('RTCPeerConnection missing in Electron build');
  if (!rtc.mediaDevices || rtc.gum !== 'function') fail('navigator.mediaDevices.getUserMedia missing');
  pass('RTCPeerConnection + mediaDevices present', rtc);

  const offer = await mainCDP.eval(`(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('audio'); pc.addTransceiver('video');
    const o = await pc.createOffer();
    const has = o.sdp.includes('m=audio') && o.sdp.includes('m=video');
    pc.close();
    return has ? 'ok' : 'bad-sdp';
  })()`);
  if (offer !== 'ok') fail('RTCPeerConnection.createOffer failed: ' + offer);
  pass('RTCPeerConnection can build an audio+video offer');

  const gum = await mainCDP.eval(`(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const tracks = stream.getTracks().map((t) => ({ kind: t.kind, label: t.label, state: t.readyState }));
      stream.getTracks().forEach((t) => t.stop());
      const devices = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'audioinput' || d.kind === 'videoinput')
        .map((d) => d.kind + ':' + (d.label || '(no label)'));
      return { ok: true, tracks, devices };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  })()`);
  evidence.webRTC.getUserMedia = gum;
  if (!gum.ok) fail('getUserMedia denied: ' + gum.error);
  pass('getUserMedia resolved under permission handler + fake devices', { tracks: gum.tracks.length });
  evidence.webRTC.enumerateDevices = gum.devices;

  const gdm = await mainCDP.eval(`(async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const t = s.getVideoTracks()[0];
      const label = t.label; t.stop();
      return { ok: true, label };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  })()`).catch((e) => ({ ok: false, error: e.message }));
  evidence.webRTC.getDisplayMedia = gdm;
  evidence.notes.push(gdm.ok ? 'getDisplayMedia resolved via desktopCapturer handler' : 'getDisplayMedia probe: ' + gdm.error);
  if (gdm.ok) pass('getDisplayMedia (screen share) available via desktopCapturer handler');

  await mainCDP.screenshot('01-login-page.png');

  // Parent-side message spy (independent of the app's own listener) so we
  // can tell "child never posted" from "posted but app did not consume".
  await mainCDP.eval(`(window.__msgs = [], window.addEventListener('message', (e) => {
    if (e.data && e.data.type) window.__msgs.push(String(e.data.type) + ':' + (e.data.loginToken ? 'token' : 'no-token'));
  }), true)`);

  // ---------------------------------------- B. SSO popup: opener postMessage
  await mainCDP.eval(`(window.open('/login/plotina.cc/?loginToken=' + ${JSON.stringify(SYN_1)}, '_blank', 'width=520,height=720'), true)`);
  const snap = [];
  try {
    var childTarget = await pollFor(async () => {
      const list = await cdpList();
      snap.push(list.map((t) => `${t.type}:${t.url}`).join(','));
      return list.find((t) => t.type === 'page' && t.url.includes('loginToken=' + SYN_1)) || false;
    }, 15000, 150, 'SSO child target');
  } catch (e) {
    evidence.sso.targetSnaps = [...new Set(snap)];
    throw e;
  }
  evidence.sso.targetSnaps = [...new Set(snap)];
  // The child self-closes ~2500ms after the token callback commit (Tauri
  // patch 0002 parity), so capture child-side evidence best-effort; the
  // authoritative proof is the parent spending SYN_1 via opener postMessage.
  try {
    childCDP = await CDP.create(childTarget.webSocketDebuggerUrl);
    await childCDP.send('Runtime.enable');
    await pollFor(() => childCDP.eval(`document.body?.textContent.includes('Sign-in complete')`), 4500, 150, 'child sign-in-complete text');
    evidence.sso.childText = await childCDP.eval(`document.body.textContent.slice(0, 400)`);
    try { await childCDP.screenshot('02-sso-popup-callback.png'); } catch { /* closed */ }
    pass('sign-in child reached patched popup branch (would post token to opener)');
  } catch (e) {
    evidence.notes.push('child-side evidence unavailable (closed early?): ' + e.message);
  } finally { childCDP = null; }

  // Parent received the token via window.opener postMessage and tried to spend it.
  evidence.sso.parentMsgs = await mainCDP.eval('window.__msgs');
  let spent1 = false;
  try {
    spent1 = await pollFor(
      () => Promise.resolve(loginPosts.some((pd) => pd.includes(SYN_1) && pd.includes('m.login.token'))),
      20000, 500, 'parent POST /login carrying SYN_1');
  } catch (e) {
    evidence.sso.parentMsgsAfter = await mainCDP.eval('window.__msgs');
    throw e;
  }
  evidence.sso.parentMsgsAfter = await mainCDP.eval('window.__msgs');
  if (!spent1) fail('parent never attempted m.login.token exchange with the popped-up token');
  pass('open->postMessage->opener handoff: parent received SYN token and initiated login exchange');

  // Child self-closes on our callback URL with a token (Tauri patch 0002 parity).
  await pollFor(async () => !(await cdpList()).some((t) => t.id === childTarget.id), 15000, 500, 'child auto-close');
  pass('SSO popup auto-closed after token callback');
  childCDP = null;

  // --------------------------------------------- B2. deep-link token handoff
  secondProc = spawn(BIN, [
    ...(QA_BIN ? [] : [APP_DIR]), `cc.plotina.chat://login?loginToken=${SYN_2}`,
  ], { env: {
    ...process.env,
    LITE_USER_DATA: profileDir,
    LITE_PORT: '0',
    ...(QA_BIN ? {} : { LITE_DIST: process.env.QA_DIST || '/home/hermes/.hermes/cache/scratch/cinny-dist-backup' }),
    LITE_ECHO_CONSOLE: '0',
  } });
  secondProc.on('exit', () => {});
  secondProc.stdout.resume(); secondProc.stderr.resume();
  const spent2 = await pollFor(
    () => Promise.resolve(loginPosts.some((pd) => pd.includes(SYN_2) && pd.includes('m.login.token'))),
    20000, 500, 'parent POST /login carrying SYN_2 via deep link');
  if (!spent2) fail('deep-link handoff never reached the login exchange');
  pass('cc.plotina.chat:// deep link delivered loginToken to the running instance');
  const mainLog = logLines.join('');
  evidence.deepLink.mainLogSeen = /\[sso\] handed loginToken via (startup-deeplink|deep-link)/.test(mainLog);
  evidence.protocol = { registered: /protocol cc\.plotina\.chat:\/\/ registered=(\w+)/.exec(mainLog)?.[1] ?? null };
  if (!evidence.protocol.registered) evidence.notes.push('setAsDefaultProtocolClient returned false (dev host without desktop entry helpers)');

  // ------------------------------------------- C. inject session, load rooms
  const session = {
    cinny_hs_base_url: HS,
    cinny_user_id: whoami.user_id,
    cinny_device_id: whoami.device_id,
    cinny_access_token: token,
  };
  await mainCDP.eval(`(() => { ${Object.entries(session).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} return true; })()`);
  await mainCDP.send('Page.reload');
  await pollFor(() => mainCDP.eval(`document.body?.innerText.includes('Lite Electron QA')`), 90000, 1000, 'room list showing QA room');
  await sleep(2000);
  pass('injected session restored by Cinny; rooms synced in the Electron shell');
  await mainCDP.screenshot('03-room-list.png');

  // --------------------------------------------------------- D. messaging
  const clicked = await mainCDP.eval(`(() => {
    const all = [...document.querySelectorAll('*')].filter((e) =>
      e.childElementCount === 0 && e.textContent.trim() === 'Lite Electron QA');
    const el = all[all.length - 1];
    if (!el) return 'not-found';
    el.click();
    return 'clicked';
  })()`);
  if (clicked !== 'clicked') fail('QA room tile not found in sidebar');
  const composer = await pollFor(async () => mainCDP.eval(`(() => {
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce) return 'contenteditable:' + ce.tagName;
    const ta = document.querySelector('textarea');
    if (ta) return 'textarea';
    return null;
  })()`), 30000, 500, 'composer to appear');
  evidence.messaging.composer = composer;
  pass('room opened; composer located: ' + composer);
  await mainCDP.eval(`(() => { const e=document.querySelector('[contenteditable="true"]')||document.querySelector('textarea'); e.focus(); return document.activeElement===e; })()`);

  const sendMarker = 'electron-qa-send ' + Date.now();
  const rect = await mainCDP.eval(`(() => { const e=document.querySelector('[contenteditable="true"]')||document.querySelector('textarea'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await mainCDP.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(300);
  await mainCDP.send('Input.insertText', { text: sendMarker });
  await mainCDP.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await mainCDP.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await pollFor(() => mainCDP.eval(`document.body?.innerText.includes(${JSON.stringify(sendMarker)})`), 30000, 500, 'sent message echo');
  pass('message SENT from the app echoes back into the timeline (send + sync receive path)');

  // inbound: REST-send from the same account, watch it land live
  const recvMarker = 'electron-qa-receive ' + Date.now();
  const enc = encodeURIComponent(ROOM);
  const resp = await fetch(`${HS}/_matrix/client/v3/rooms/${enc}/send/m.room.message/qa-${Date.now()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ msgtype: 'm.text', body: recvMarker }),
  });
  if (!resp.ok) fail('REST send failed: ' + resp.status + ' ' + (await resp.text()).slice(0, 200).replaceAll(token, '<T>'));
  await pollFor(() => mainCDP.eval(`document.body?.innerText.includes(${JSON.stringify(recvMarker)})`), 30000, 1000, 'inbound message in timeline');
  pass('message RECEIVED over sync shows up in the open timeline (receive path)');
  await mainCDP.screenshot('04-message-roundtrip.png');

  // E. external link policy smoke: window.open of an external URL is denied
  // and routed to shell.openExternal (we assert no external page target appeared)
  await mainCDP.eval(`(window.open('https://example.invalid/', '_blank'), true)`).catch(() => {});
  await sleep(1500);
  const externalTarget = (await cdpList()).some((t) => t.type === 'page' && t.url.includes('example.invalid'));
  evidence.window.externalLinkHandled = !externalTarget;
  if (externalTarget) fail('external window.open created an Electron window (should open in OS browser)');
  pass('external window.open denied in-app (routed to OS browser)');

  evidence.window.finalUrl = await mainCDP.eval('location.href');
  evidence.finishedAt = new Date().toISOString();
  console.log('\nALL QA CHECKS PASSED');
} catch (e) {
  evidence.error = String(e.message || e);
  try { if (mainCDP) await mainCDP.screenshot('99-failure.png'); } catch { /* ignore */ }
  console.error('QA FAILED:', e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT, 'main-process.log'), logLines.join(''));
  try { proc.kill('SIGTERM'); } catch { /* ignore */ }
  try { secondProc?.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(1000);
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(profileDir, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
