#!/usr/bin/env node
// Plotina Lite Desktop — Electron regression harness (executable slice of
// docs/LITE_ELECTRON_REGRESSION.md).
//
// Run through run-regression.sh (which provisions display/ports/temp HOME and
// the cleanup trap). Scenarios record pass/fail/skip into results.json +
// REPORT.md; screenshots land in shots/.
//
// Scope note (2026-11-07 QA direction): Tauri .17 upgrade/migration scenarios
// (I-06/I-07, A-07, A-08) are deprioritized — real users have no Tauri install.
// This harness covers CLEAN installs of Electron Lite and Electron→Electron
// update paths (no-update / valid update / bad sha512 / QA-feed gating).
//
// The Matrix access token is read from --token-file and NEVER printed; all
// free text passes through the Recorder's redactor before hitting disk.
'use strict';

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CDP, sleep, pollFor, listTargets, pageTargets, waitForPageTarget, cdpUp } from './lib/cdp.mjs';
import { resolveTarget, launchApp, killApp, installFingerprint } from './lib/launch.mjs';
import { Recorder, makeRedactor } from './lib/report.mjs';
import { buildFeed, serveFeed } from './updater-feed.mjs';

// ------------------------------------------------------------------ config
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const TARGET = arg('target', null);
if (!TARGET) {
  console.error('usage: regression.mjs --target <AppImage|deb|unpacked dir> --out DIR');
  process.exit(64);
}
const OUT = path.resolve(arg('out', process.env.QA_OUT || '/tmp/lite-qa-run'));
const CDP_PORT = Number(process.env.QA_CDP_PORT || 0);
const FEED_PORT = Number(process.env.QA_FEED_PORT || 0);
if (!CDP_PORT) throw new Error('QA_CDP_PORT must be set (run-regression.sh picks a free one)');
const SHOTS = path.join(OUT, 'shots');
const LOGS = path.join(OUT, 'logs');
const TOKEN_FILE = arg('token-file', process.env.QA_TOKEN_FILE || '/home/hermes/.hermes/cache/qa-matrix-token');
const HS = process.env.QA_HS || 'https://plotina.cc';
const ROOM = process.env.QA_ROOM || '!mUPrflIuBoqnUl_g4GY3zuEozT6vCU5jUatII4SwiGY';
const ROOM_NAME = process.env.QA_ROOM_NAME || 'Lite Electron QA';
const SSO_CALLBACK = process.env.QA_SSO_CALLBACK || '/login/plotina.cc/';
const OBSERVE_MS = Number(process.env.QA_UPDATER_OBSERVE_MS || 15000);

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const token = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
const redact = makeRedactor([token]);
const rec = new Recorder(OUT, redact);

let launchSeq = 0;
const resolved = resolveTarget(TARGET);
// Profiles live OUTSIDE the evidence dir: the app's own localStorage keeps
// the injected token, and evidence must never carry token material.
const PROFILES = fs.mkdtempSync(path.join(os.tmpdir(), `lite-qa-profiles-${process.env.QA_RUN_ID || Date.now()}-`));

// Frozen dist for the unpackaged prototype (packaged builds embed their own).
const DIST = [process.env.QA_DIST,
  '/home/hermes/.hermes/cache/scratch/cinny-dist-backup',
  '/home/hermes/build/cinny-desktop/cinny/dist',
].find((d) => d && fs.existsSync(path.join(d, 'index.html'))) || null;

rec.setMeta({
  target: path.resolve(TARGET),
  targetKind: resolved.kind,
  display: process.env.DISPLAY || null,
  cdpPort: CDP_PORT,
  feedPort: FEED_PORT,
  node: process.version,
  dist: DIST,
  harnessCommit: (() => {
    try {
      return spawnSync('git', ['-C', path.resolve(import.meta.dirname, '../../..'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    } catch { return null; }
  })(),
});

const watchdog = setTimeout(() => {
  console.error('WATCHDOG: regression run exceeded 30 min — dumping partial results');
  rec.note('watchdog timeout');
  try { rec.writeMarkdown(); } catch { /* ignore */ }
  process.exit(2);
}, 30 * 60 * 1000);

// ------------------------------------------------------------------ app ctx
const ctx = {
  main: null,          // { handle, cdp, origin, target, profile, loginPosts, logFile }
  mainProfile: null,   // persistent across restarts within the chain
  feed: null,          // { server, accessLog, cases }
  updaterPresent: null,// tri-state: null unknown / false / true (feed was consulted with QA flag)
  note: (m) => rec.note(m),
};

async function attachMain(handle, profileDir) {
  // Wait for the real app page: origin must be the live http://127.0.0.1:<port>
  // (the app may fall back to an ephemeral port; never assume 44548).
  const target = await pollFor(async () => {
    const t = (await pageTargets(CDP_PORT)).find((x) => /^http:\/\/127\.0\.0\.1:\d+/.test(x.url || ''));
    return t || false;
  }, 45000, 400, 'app page target on http://127.0.0.1');
  const origin = new URL(target.url).origin;
  const cdp = await CDP.create(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  const loginPosts = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    if (p.request?.method === 'POST' && /\/_matrix\/client\/[^/]+\/login/.test(p.request.url)) {
      loginPosts.push(p.request.postData || '');
    }
  });
  return { handle, cdp, origin, target, profile: profileDir, loginPosts };
}

function baseEnv(profileDir, { stablePort = false } = {}) {
  const env = {
    LITE_USER_DATA: profileDir,
    // Main-chain launches keep the origin port stable across restarts:
    // localStorage/IndexedDB are partitioned per origin, so an ephemeral port
    // every launch would log the profile out by itself (packaged builds pin
    // 44548; see matrix D3/D7). Other launches (dup/second/updater) use 0 so
    // they can never collide with the running holder.
    LITE_PORT: stablePort && ctx.appPort ? String(ctx.appPort) : '0',
    LITE_ECHO_CONSOLE: '1',
    QA_RUN_ID: process.env.QA_RUN_ID || '',
  };
  if (resolved.kind === 'prototype' && DIST) env.LITE_DIST = DIST;
  return env;
}

async function startMain(label, { keepProfile = null, stablePort = false } = {}) {
  const profile = keepProfile || fs.mkdtempSync(path.join(PROFILES, `${label}-`));
  const logFile = path.join(LOGS, `${label}-${++launchSeq}.log`);
  const handle = launchApp(resolved, {
    label,
    logFile,
    redact,
    env: baseEnv(profile, { stablePort }),
    args: [
      `--remote-debugging-port=${CDP_PORT}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--no-first-run',
    ],
  });
  const main = await attachMain(handle, profile);
  // Record the live origin port so every later main-chain relaunch reuses it
  // (session storage is per-origin; this mirrors the packaged 44548 pin).
  ctx.appPort = Number(new URL(main.origin).port);
  main.logFile = logFile;
  return main;
}

async function ensureMain(label = 'main') {
  if (ctx.main && !ctx.main.handle.exited) return ctx.main;
  if (ctx.main) { // died between scenarios: restart with same profile if we have one
    try { ctx.main.cdp.close(); } catch { /* ignore */ }
  }
  const profile = ctx.mainProfile || fs.mkdtempSync(path.join(PROFILES, `${label}-`));
  ctx.mainProfile = profile;
  ctx.main = await startMain(`${label}-re`, { keepProfile: profile, stablePort: true });
  return ctx.main;
}

async function killMain(graceful = true) {
  if (!ctx.main) return;
  if (graceful) {
    try { process.kill(-ctx.main.handle.proc.pid, 'SIGTERM'); } catch { /* gone */ }
    try { await ctx.main.handle.waitForExit(15000); } catch { killApp(ctx.main.handle); }
  } else {
    killApp(ctx.main.handle);
  }
  try { ctx.main.cdp.close(); } catch { /* ignore */ }
  ctx.main = null;
}

// On this Xvfb host a Chromium launched while the previous instance's GPU/X
// resources are still being torn down can die with
// "GPU process isn't usable. Goodbye." (SIGTRAP) — observed once in dryrun2/3.
// Give the teardown a beat and retry once before declaring a crash.
async function relaunchMain(label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await sleep(attempt === 1 ? 3000 : 6000);
    try {
      const m = await startMain(attempt === 1 ? label : `${label}-retry`, { keepProfile: ctx.mainProfile, stablePort: true });
      await sleep(2500); // catch immediate-crash-after-attach
      if (m.handle.exited) {
        lastErr = new Error(`${label} exited right after launch (code=${m.handle.exitInfo?.code} sig=${m.handle.exitInfo?.sig})`);
        rec.note(`relaunch attempt ${attempt}: ${lastErr.message}`);
        continue;
      }
      if (attempt > 1) rec.note(`${label} succeeded on relaunch attempt ${attempt} (host GPU/teardown flake)`);
      return m;
    } catch (e) {
      lastErr = e;
      rec.note(`relaunch attempt ${attempt} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('relaunch failed');
}

async function waitForRooms(main, timeout = 90000) {
  const v = await pollFor(async () => {
    if (main.handle.exited) return 'crashed';
    return main.cdp.eval(`document.body?.innerText.includes(${JSON.stringify(ROOM_NAME)})`);
  }, timeout, 1000, 'room list visible');
  if (v === 'crashed') throw Object.assign(new Error(`app crashed mid-load (code=${main.handle.exitInfo?.code} sig=${main.handle.exitInfo?.sig})`), { crashed: true });
}

async function isLoggedIn(main) {
  try {
    const href = await main.cdp.eval('location.href');
    return !/\/login/.test(href);
  } catch { return false; }
}

async function waitForLoginRoute(main) {
  await pollFor(() => main.cdp.eval(`(async () => {
    for (let i=0;i<40;i++){ if (location.pathname.startsWith('/login') || document.body?.innerText.includes('Login')) return true; await new Promise(r=>setTimeout(r,250)); }
    return false; })()`), 30000, 1000, 'login route');
}

async function injectSession(main) {
  const whoami = await (await fetch(`${HS}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  })).json();
  if (!whoami.user_id) throw new Error('whoami failed for QA token file');
  const session = {
    cinny_hs_base_url: HS,
    cinny_user_id: whoami.user_id,
    cinny_device_id: whoami.device_id,
    cinny_access_token: token,
  };
  await main.cdp.eval(`(() => { ${Object.entries(session).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')} return true; })()`);
  await main.cdp.send('Page.reload');
  await pollFor(() => main.cdp.eval(`document.body?.innerText.includes(${JSON.stringify(ROOM_NAME)})`), 90000, 1000, 'room list after session inject');
  return whoami;
}

async function xdotool(args, timeout = 8000) {
  try {
    const r = spawnSync('xdotool', args, { encoding: 'utf8', timeout });
    return r.status === 0 ? (r.stdout || '').trim() : null;
  } catch { return null; }
}
async function xprop(id, prop) {
  try {
    const r = spawnSync('xprop', ['-id', id, prop], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? (r.stdout || '') : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- scenarios
const scenarios = [];
const scenario = (meta, fn) => scenarios.push({ meta, fn });

// ------------------------------------------------------------- L-01 launch
scenario({ id: 'L-01', name: 'clean launch, app serves, login page, no early exit', matrix: ['I-01', 'A-01'], priority: 'P0' }, async () => {
  if (resolved.kind === 'prototype' && !DIST) {
    return { status: 'fail', detail: 'no Cinny dist found for prototype target (QA_DIST unset, backups missing)' };
  }
  ctx.mainProfile = fs.mkdtempSync(path.join(PROFILES, 'main-'));
  ctx.main = await startMain('main', { keepProfile: ctx.mainProfile });
  const { main } = ctx;
  await sleep(5000); // alive-check window (matrix wants 30 s; 5 s + later use covers crashes)
  if (main.handle.exited) throw new Error(`app exited during launch: code=${main.handle.exitInfo?.code}`);
  const http = await fetch(`${main.origin}/`, { signal: AbortSignal.timeout(8000) });
  if (http.status !== 200) throw new Error(`app origin ${main.origin} returned ${http.status}`);
  await waitForLoginRoute(main);
  await sleep(1500);
  const shot = await main.cdp.screenshot(path.join(SHOTS, '01-login.png'));
  // Native title lives on the X11 window (Electron setTitle); the CDP page
  // target title is the document <title> ("Cinny"). Browser.getWindowForTarget
  // is unavailable on page-level WebSockets, so L-02 (xdotool/xprop) asserts
  // the native title; here we record both for the report.
  let nativeTitle = 'n/a (no X11 tools)';
  if (spawnSync('xdotool', ['--version'], { encoding: 'utf8' }).stdout) {
    const win = await xdotool(['search', '--name', 'Plotina Lite Desktop']);
    if (win) {
      const wm = await xprop(win.split('\n')[0].trim(), 'WM_NAME');
      nativeTitle = wm ? (/= "(.*)"/.exec(wm)?.[1] ?? wm.trim()) : '(none)';
    } else nativeTitle = '(xdotool found no window)';
  }
  const pageTitle = (await listTargets(CDP_PORT)).find((t) => t.id === main.target.id)?.title || null;
  const errScan = /ERR_[A-Z_]+|uncaught/i.test(main.handle.logText());
  // --version evidence (informational; Chromium prints its own version for unpackaged electron)
  const ver = spawnSync(resolved.cmd, [...resolved.prefixArgs, '--version'], { encoding: 'utf8', timeout: 10000 });
  let verFile = null;
  if (ver.status === 0) {
    verFile = path.join(OUT, 'version.txt');
    fs.writeFileSync(verFile, ver.stdout);
  }
  const evidence = [shot, main.logFile, ...(verFile ? [verFile] : [])];
  if (errScan) rec.note('app log contains ERR_/uncaught patterns — check log');
  return {
    status: 'pass',
    detail: `alive, origin ${main.origin}, native title '${nativeTitle}' (page title '${pageTitle}'), login page rendered${errScan ? ' (log has ERR_ strings — see app.log)' : ''}`,
    evidence,
  };
});

// ----------------------------------------------------- L-02 WM identity (X11)
scenario({ id: 'L-02', name: 'WM_CLASS + _NET_WM_ICON non-empty + title (X11)', matrix: ['D-06'], priority: 'P0' }, async () => {
  const { main } = ctx;
  if (!spawnSync('xdotool', ['--version'], { encoding: 'utf8' }).stdout) {
    return { status: 'skip', reason: 'xdotool not installed on this host' };
  }
  const found = await xdotool(['search', '--name', 'Plotina Lite Desktop']);
  if (!found) return { status: 'fail', detail: 'xdotool found no window named "Plotina Lite Desktop"' };
  const ids = found.split('\n').map((s) => s.trim()).filter(Boolean);
  let wmClass = null; let iconDims = null; let iconTokens = 0; let winId = null; let wmName = null;
  for (const id of ids) {
    const c = await xprop(id, 'WM_CLASS');
    if (!c) continue;
    const icon = await xprop(id, '_NET_WM_ICON');
    const hasIcon = !!icon && !/not found$/i.test(icon) && icon.includes('=');
    if (!hasIcon && !/plotina/i.test(c)) continue;
    winId = id;
    wmClass = c;
    wmName = (await xprop(id, 'WM_NAME')) || '';
    wmName = /= "(.*)"/.exec(wmName)?.[1] ?? wmName.trim();
    if (hasIcon) {
      const vals = icon.slice(icon.indexOf('=') + 1).split(',').map((s) => s.trim()).filter((s) => /^-?\d+$/.test(s));
      if (vals.length >= 3) {
        const w = Number(vals[0]); const h = Number(vals[1]);
        iconDims = { w, h, pixelsProvided: vals.length - 2 };
        iconTokens = vals.length;
      } // else: property exists but is EMPTY (Electron dev build without icon registration)
    }
    if (hasIcon && wmClass) break;
  }
  const xpropDump = path.join(OUT, 'xprop-window.txt');
  fs.writeFileSync(xpropDump, `winid=${winId}\nWM_NAME: ${wmName}\nWM_CLASS:\n${wmClass || '(none)'}\n_ICON dims: ${JSON.stringify(iconDims)} tokens=${iconTokens}\n`);
  if (!wmClass) throw new Error('no app window found via xdotool/xprop');
  const titleOk = /Plotina Lite Desktop/.test(wmName || '');
  const classOk = /plotina/i.test(wmClass);
  const iconOk = iconDims && iconDims.w >= 128 && iconDims.pixelsProvided >= iconDims.w * iconDims.h;
  const detail = `WM_NAME='${wmName}' WM_CLASS=${(wmClass.split('=')[1] || '').trim()} icon=${iconDims ? `${iconDims.w}x${iconDims.h} (${iconDims.pixelsProvided}px)` : 'EMPTY'}`;
  if (!titleOk) throw new Error(`native window title not 'Plotina Lite Desktop' — ${detail}`);
  if (!iconOk) throw new Error(`_NET_WM_ICON missing or <128px — ${detail}`);
  if (!classOk) throw new Error(`WM_CLASS does not contain 'plotina' — ${detail}`);
  return { detail, evidence: [xpropDump] };
});

// ----------------------------------------------------------- V-01 themes
scenario({ id: 'V-01', name: 'theme follows prefers-color-scheme (CDP emulation), dark+light shots', matrix: ['D-03'], priority: 'P0' }, async () => {
  const { main } = ctx;
  const read = async () => main.cdp.eval(`(() => {
    const bg = (el) => getComputedStyle(el).backgroundColor;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    return { dark, body: bg(document.body), root: bg(document.documentElement) };
  })()`);
  await main.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(1200);
  const dark = await read();
  const darkShot = await main.cdp.screenshot(path.join(SHOTS, '02-theme-dark.png'));
  await main.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(1200);
  const light = await read();
  const lightShot = await main.cdp.screenshot(path.join(SHOTS, '03-theme-light.png'));
  await main.cdp.send('Emulation.setEmulatedMedia', { features: [] });
  const changed = JSON.stringify(dark) !== JSON.stringify(light);
  if (!changed) throw new Error(`page did not react to prefers-color-scheme: dark=${JSON.stringify(dark)} light=${JSON.stringify(light)}`);
  return { detail: `dark: matchMedia=${dark.dark} bg=${dark.body} | light: matchMedia=${light.dark} bg=${light.body}`, evidence: [darkShot, lightShot] };
});

// ----------------------------------------------------------- W-01 WebRTC
scenario({ id: 'W-01', name: 'WebRTC available: RTCPeerConnection offer + fake-media getUserMedia', matrix: ['C-01 prereq', '§5.1'], priority: 'P0' }, async () => {
  const { main } = ctx;
  const rtc = await main.cdp.eval(`({
    secure: window.isSecureContext, origin: location.origin,
    rtcType: typeof RTCPeerConnection,
    mediaDevices: !!navigator.mediaDevices,
    gum: typeof navigator.mediaDevices?.getUserMedia,
    gdm: typeof navigator.mediaDevices?.getDisplayMedia,
  })`);
  if (!rtc.secure) throw new Error('app origin is not a secure context');
  if (rtc.rtcType !== 'function') throw new Error('RTCPeerConnection missing (this is why we left WebKitGTK!)');
  if (!rtc.mediaDevices || rtc.gum !== 'function') throw new Error('mediaDevices.getUserMedia missing');
  const offer = await main.cdp.eval(`(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('audio'); pc.addTransceiver('video');
    const o = await pc.createOffer(); pc.close();
    return o.sdp.includes('m=audio') && o.sdp.includes('m=video') ? 'ok' : 'bad-sdp';
  })()`);
  if (offer !== 'ok') throw new Error('createOffer failed: ' + offer);
  const gum = await main.cdp.eval(`(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const tracks = s.getTracks().map((t) => t.kind + ':' + t.label + ':' + t.readyState);
      s.getTracks().forEach((t) => t.stop());
      return { ok: true, tracks };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  })()`);
  if (!gum.ok) throw new Error('getUserMedia denied under fake devices: ' + gum.error);
  const gdm = await main.cdp.eval(`(async () => {
    try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); s.getTracks().forEach(t=>t.stop()); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e?.message || e) }; }
  })()`).catch((e) => ({ ok: false, error: e.message }));
  rec.note(`getDisplayMedia (screen-share) probe: ${gdm.ok ? 'available' : gdm.error}`);
  const file = path.join(OUT, 'webrtc.json');
  fs.writeFileSync(file, JSON.stringify({ rtc, offer, gum, gdm }, null, 2));
  return { detail: `offer ok; gUM tracks ${gum.tracks.join(', ')}; getDisplayMedia ${gdm.ok ? 'ok' : 'n/a (Xvfb)'}`, evidence: [file] };
});

// ----------------------------------------------------------- S-01 SSO popup
scenario({ id: 'S-01', name: 'SSO popup: single instance, opener handoff, self-close (synthetic token)', matrix: ['A-02', 'A-03'], priority: 'P0' }, async () => {
  const { main } = ctx;
  await waitForLoginRoute(main); // make sure we are on Login (fresh profile)
  const SYN = 'SYN_QA_' + Date.now();
  await main.cdp.eval(`(window.__msgs = [], window.addEventListener('message', (e) => {
    if (e.data && e.data.type) window.__msgs.push(String(e.data.type) + ':' + (e.data.loginToken ? 'token' : 'no-token'));
  }), true)`);
  await main.cdp.eval(`(window.open(${JSON.stringify(SSO_CALLBACK + '?loginToken=' + SYN)}, '_blank', 'width=520,height=720'), true)`);
  const child = await pollFor(async () => (await pageTargets(CDP_PORT)).find((t) => (t.url || '').includes('loginToken=' + SYN)) || false,
    15000, 200, 'SSO child target');
  const childCount = (await pageTargets(CDP_PORT)).filter((t) => (t.url || '').includes('loginToken=' + SYN)).length;
  let evidence = [];
  try {
    const childCDP = await CDP.create(child.webSocketDebuggerUrl);
    await childCDP.send('Runtime.enable');
    try {
      await pollFor(() => childCDP.eval(`document.body?.textContent.includes('Sign-in complete')`), 6000, 200, 'child sign-in-complete');
      evidence.push(await childCDP.screenshot(path.join(SHOTS, '04-sso-callback.png')));
    } catch { /* child may close first; parent-side proof below */ }
    childCDP.close();
  } catch (e) { rec.note('child-side evidence unavailable: ' + e.message); }
  if (childCount !== 1) throw new Error(`expected exactly 1 SSO popup, saw ${childCount} (single-instance popup policy broken)`);
  // Parent must receive the token postMessage and attempt the login exchange.
  await pollFor(() => Promise.resolve(main.loginPosts.some((pd) => pd.includes(SYN) && pd.includes('m.login.token'))),
    20000, 400, 'parent POST /login carrying the SYN token');
  // Popup must self-close.
  await pollFor(async () => !(await listTargets(CDP_PORT)).some((t) => t.id === child.id), 15000, 300, 'popup self-close');
  const msgs = await main.cdp.eval('window.__msgs');
  return { detail: `one popup; opener got token (${msgs.length} msg(s)); POST /login with m.login.token initiated; popup auto-closed`, evidence };
});

// ------------------------------------------------- S-02 deep-link token handoff
scenario({ id: 'S-02', name: 'deep-link loginToken reaches the running instance (second process exits 0)', matrix: ['A-02', 'D-02'], priority: 'P1' }, async () => {
  const { main } = ctx;
  const SYN2 = 'SYN_QA_' + Date.now() + '_2';
  const env = baseEnv(main.profile);
  delete env.LITE_ECHO_CONSOLE;
  const second = launchApp(resolved, {
    label: 'deeplink',
    logFile: path.join(LOGS, 'deeplink.log'),
    redact,
    env,
    args: [`cc.plotina.chat://login?loginToken=${SYN2}`],
  });
  const exit = await second.waitForExit(20000);
  if (exit.code !== 0) throw new Error(`second instance exited with code ${exit.code}`);
  await pollFor(() => Promise.resolve(main.loginPosts.some((pd) => pd.includes(SYN2) && pd.includes('m.login.token'))),
    20000, 400, 'POST /login with deep-linked token');
  const logSeen = /\[sso\] handed loginToken via (startup-deeplink|deep-link|deep-link-inbox)/.test(main.handle.logText());
  if (!main.handle.exited) { /* holder still fine */ }
  return { detail: `second process exit 0; token delivered${logSeen ? ' (main log confirms handoff)' : ''}` };
});

// ---------------------------------------------------------- D-01 ext links
scenario({ id: 'D-01', name: 'external links routed to OS browser (fake xdg-open), no in-app window', matrix: ['D-01', 'R-05'], priority: 'P0' }, async () => {
  const { main } = ctx;
  const logPath = process.env.QA_XDG_LOG;
  if (!logPath) return { status: 'skip', reason: 'QA_XDG_LOG unset — run via run-regression.sh (fake xdg-open not active)' };
  fs.writeFileSync(logPath, ''); // truncate
  await main.cdp.eval(`(window.open('https://example.invalid/qa-ext-link', '_blank'), true)`).catch(() => {});
  await sleep(1500);
  await main.cdp.eval(`(() => { const a=document.createElement('a'); a.href='https://example.invalid/qa-anchor'; a.click(); return true; })()`).catch(() => {});
  await sleep(1500);
  const targets = await pageTargets(CDP_PORT);
  const leaked = targets.filter((t) => (t.url || '').includes('example.invalid'));
  const href = await main.cdp.eval('location.href');
  const captured = fs.readFileSync(logPath, 'utf8');
  const extHits = captured.split('\n').filter((l) => l.includes('example.invalid'));
  fs.writeFileSync(path.join(OUT, 'xdg-open.log'), captured);
  if (leaked.length) throw new Error(`external URL opened an Electron window: ${leaked.map((t) => t.url).join(', ')}`);
  if (!href.startsWith(main.origin)) throw new Error(`app navigated away: ${href}`);
  if (extHits.length === 0) throw new Error('fake xdg-open captured nothing — external URLs are not routed to the OS browser');
  rec.note(`xdg-open got ${extHits.length} external URL(s): ${extHits.join(' | ')}`);
  // mailto + file:// probes recorded as R-05 findings (not hard failures yet):
  await main.cdp.eval(`(() => { location.assign('mailto:qa@example.invalid'); return true; })()`).catch(() => {});
  await sleep(1200);
  const afterMailto = fs.readFileSync(logPath, 'utf8');
  if (/file:\//.test(afterMailto)) rec.note('R-05 finding: file:// URL was routed to xdg-open');
  if (!/mailto:/.test(afterMailto)) rec.note('D-01 observation: mailto: was not routed to the OS handler');
  return {
    detail: `${extHits.length} URL(s) → fake xdg-open; no in-app external window; app stayed on ${main.origin}`,
    evidence: [path.join(OUT, 'xdg-open.log')],
  };
});

// ---------------------------------------------------------- M-01 messaging
scenario({ id: 'M-01', name: 'messaging: injected session loads rooms; send echo + REST inbound received', matrix: ['M-01', 'A-04..A-06'], priority: 'P0' }, async () => {
  if (!token) return { status: 'skip', reason: `no token at ${TOKEN_FILE} — messaging checks need the QA Matrix session file` };
  const { main } = ctx;
  let whoami;
  try {
    whoami = await injectSession(main);
  } catch (e) {
    throw new Error(String(e.message).split(token).join('<REDACTED>'));
  }
  await sleep(2000);
  rec.note(`QA user ${whoami.user_id} (device ${whoami.device_id})`);
  const roomShot = await main.cdp.screenshot(path.join(SHOTS, '05-room-list.png'));
  const clicked = await main.cdp.eval(`(() => {
    const all = [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && e.textContent.trim() === ${JSON.stringify(ROOM_NAME)});
    const el = all[all.length - 1];
    if (!el) return 'not-found';
    el.click(); return 'clicked';
  })()`);
  if (clicked !== 'clicked') throw new Error('QA room tile not found in sidebar');
  const composer = await pollFor(async () => main.cdp.eval(`(() => {
    const ce = document.querySelector('[contenteditable="true"]');
    if (ce) return 'contenteditable';
    return document.querySelector('textarea') ? 'textarea' : null;
  })()`), 30000, 400, 'composer');
  const rect = await main.cdp.eval(`(() => { const e=document.querySelector('[contenteditable="true"]')||document.querySelector('textarea'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await main.cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  }
  await sleep(300);
  const sendMarker = 'lite-qa-send-' + Date.now();
  await main.cdp.send('Input.insertText', { text: sendMarker });
  for (const t of ['keyDown', 'keyUp']) {
    await main.cdp.send('Input.dispatchKeyEvent', { type: t, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }
  await pollFor(() => main.cdp.eval(`document.body?.innerText.includes(${JSON.stringify(sendMarker)})`), 30000, 500, 'sent message echo');
  const recvMarker = 'lite-qa-recv-' + Date.now();
  const resp = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/send/m.room.message/qa-${Date.now()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ msgtype: 'm.text', body: recvMarker }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error('REST send failed: ' + resp.status);
  await pollFor(() => main.cdp.eval(`document.body?.innerText.includes(${JSON.stringify(recvMarker)})`), 30000, 500, 'inbound message in timeline');
  const rtShot = await main.cdp.screenshot(path.join(SHOTS, '06-message-roundtrip.png'));
  return { detail: 'sent from UI echoes; REST-sent message arrived over sync', evidence: [roomShot, rtShot] };
});

// ---------------------------------------------------------- R-01 restart
scenario({ id: 'R-01', name: 'session survives restart (same profile+origin, no re-login)', matrix: ['A-05', 'A-06'], priority: 'P0' }, async () => {
  await killMain(true);
  ctx.main = await relaunchMain('restart');
  let roomsOk = false;
  let crashedOnce = false;
  for (const budget of [60000, 90000]) {
    try {
      await waitForRooms(ctx.main, budget);
      roomsOk = true;
      break;
    } catch (e) {
      if (e.crashed && !crashedOnce) {
        crashedOnce = true;
        rec.note(`restart ${e.message}; relaunching once (host GPU/teardown flake)`);
        ctx.main = await relaunchMain('restart');
        continue;
      }
      if (e.crashed) throw e;
      // alive but slow: one more budget round, then give up
    }
  }
  if (!roomsOk) {
    const href = await ctx.main.cdp.eval('location.href').catch(() => '(unreadable)');
    throw new Error(`room list did not load after restart within 150s (app ${ctx.main.handle.exited ? 'CRASHED' : 'alive'}, at ${href})`);
  }
  const href = await ctx.main.cdp.eval('location.href');
  if (/\/login/.test(href)) throw new Error('app returned to login after restart — session not persisted');
  const shot = await ctx.main.cdp.screenshot(path.join(SHOTS, '07-after-restart.png'));
  return { detail: `origin-port ${ctx.appPort} held across restart; ${href}; rooms loaded without re-injecting the token`, evidence: [shot] };
});

// ---------------------------------------------------------- D-08 window state
scenario({ id: 'D-08', name: 'window bounds persist across graceful quit + relaunch (X11)', matrix: ['D-08'], priority: 'P1' }, async () => {
  // Electron's devtools endpoint does NOT expose Browser.getWindowForTarget/
  // setWindowBounds (probed: -32601), so move/resize via XTEST through xdotool
  // and verify against the app's own window-state.json + live geometry.
  if (!spawnSync('xdotool', ['--version'], { encoding: 'utf8' }).stdout) {
    return { status: 'skip', reason: 'xdotool not installed' };
  }
  const win = await xdotool(['search', '--name', 'Plotina Lite Desktop']);
  if (!win) throw new Error('no window to move');
  const id = win.split('\n')[0].trim();
  await xdotool(['windowmove', id, '170', '120']);
  await xdotool(['windowsize', id, '1000', '680']);
  await sleep(1600); // main.js debounces saves by 500 ms
  await killMain(true);
  const stateFile = path.join(ctx.mainProfile, 'window-state.json');
  if (!fs.existsSync(stateFile)) throw new Error('window-state.json not written on quit');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const stateCopy = path.join(OUT, 'window-state.json');
  fs.copyFileSync(stateFile, stateCopy); // evidence lives outside the wiped profile dir
  if (Math.abs((saved.width || 0) - 1000) > 120 || Math.abs((saved.height || 0) - 680) > 120) {
    throw new Error(`saved bounds wrong after xdotool move/resize: ${JSON.stringify(saved)}`);
  }
  ctx.main = await relaunchMain('restore');
  await sleep(1500);
  const win2 = await xdotool(['search', '--name', 'Plotina Lite Desktop']);
  if (!win2) throw new Error('relaunched window not found');
  const geom = await xdotool(['getwindowgeometry', win2.split('\n')[0].trim()]);
  const pos = /Position:\s*(\d+),(\d+)/.exec(geom || '');
  const size = /Geometry:\s*(\d+)x(\d+)/.exec(geom || '');
  const shot = await ctx.main.cdp.screenshot(path.join(SHOTS, '08-window-restored.png'));
  if (!pos || !size) throw new Error(`cannot parse geometry: ${geom}`);
  const off = Math.max(Math.abs(Number(size[1]) - saved.width), Math.abs(Number(size[2]) - saved.height));
  if (off > 80) throw new Error(`restored ${size[1]}x${size[2]}@${pos[1]},${pos[2]} drifted from saved ${saved.width}x${saved.height}@${saved.x},${saved.y} (Δ${off})`);
  return { detail: `saved ${saved.width}x${saved.height}@${saved.x},${saved.y} → restored ${size[1]}x${size[2]}@${pos[1]},${pos[2]} (Δ${off}px)`, evidence: [stateCopy, shot] };
});

// ---------------------------------------------------------- D-11 single instance
scenario({ id: 'D-11', name: 'second launch exits 0, no second window, holder focuses', matrix: ['D-11'], priority: 'P0' }, async () => {
  const { main } = ctx;
  const before = (await pageTargets(CDP_PORT)).length;
  const env = baseEnv(main.profile);
  const second = launchApp(resolved, { label: 'dup', logFile: path.join(LOGS, 'dup.log'), redact, env, args: [] });
  const exit = await second.waitForExit(20000);
  if (exit.code !== 0) throw new Error(`second instance exit code ${exit.code} (expected 0)`);
  await sleep(1500);
  const after = (await pageTargets(CDP_PORT)).length;
  if (main.handle.exited) throw new Error('holder died when a second instance started');
  if (after !== before) throw new Error(`window count changed: ${before} → ${after}`);
  const logOk = /\[main\] second-instance/.test(main.handle.logText());
  if (!logOk) rec.note('no "[main] second-instance" log line (packaged builds may focus via a different path)');
  return { detail: `second instance exit 0; still ${after} page target(s); holder ${logOk ? 'logged second-instance and' : 'remains'} alive` };
});

// ---------------------------------------------------------- V-02 noise dropdown
scenario({ id: 'V-02', name: 'noise-suppression dropdown readability (contrast >=4.5:1, dark+light)', matrix: ['D-04', 'C-06'], priority: 'P1' }, async () => {
  const { main } = ctx;
  // Best-effort settings navigation; skip honestly if the UI path is not found.
  const opened = await main.cdp.eval(`(async () => {
    const cands = [...document.querySelectorAll('button,[role="button"],a,div,span')].filter((e) =>
      /^(settings|config)/i.test((e.textContent || '').trim()) || /settings/i.test(e.getAttribute('title') || e.getAttribute('aria-label') || ''));
    for (const el of cands) { el.click(); await new Promise(r=>setTimeout(r,900));
      if (document.querySelector('select')) return 'opened:' + (el.textContent || el.title || '').trim().slice(0,20); }
    return null;
  })()`).catch(() => null);
  const selInfo = await main.cdp.eval(`(() => {
    const sels = [...document.querySelectorAll('select')];
    if (!sels.length) return null;
    const s = sels.find((x) => /noise|suppression|level/i.test(x.outerHTML)) || sels[0];
    const cs = getComputedStyle(s);
    const parentBg = (() => { let e = s; while (e) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(b)) return b; e = e.parentElement; } return cs.backgroundColor; })();
    return { count: sels.length, color: cs.color, bg: parentBg, selectedText: s.options[s.selectedIndex]?.text || '' };
  })()`);
  if (!selInfo) {
    return { status: 'skip', reason: 'settings/noise select not reachable from current UI path (opened=' + opened + ') — needs the call screen or a Settings deep link' };
  }
  const ratio = contrast(selInfo.color, selInfo.bg);
  const shot = await main.cdp.screenshot(path.join(SHOTS, '09-noise-select.png'));
  if (ratio < 4.5) throw new Error(`noise select contrast ${ratio.toFixed(2)} < 4.5 (${selInfo.color} on ${selInfo.bg})`);
  return { detail: `select found (${selInfo.count}, e.g. "${selInfo.selectedText}"), contrast ${ratio.toFixed(2)}:1`, evidence: [shot] };
});
function lum(rgb) {
  const m = rgb.match(/\d+/g); if (!m) return null;
  const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
  const a = lum(fg); const b = lum(bg);
  if (a === null || b === null) return 0;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---------------------------------------------------------- U-00 feed fixture
scenario({ id: 'U-00', name: 'local updater-feed fixtures (sha512/size correct; tampered case differs); feed server up', matrix: ['U-06'], priority: 'P1' }, async () => {
  const feedDir = path.join(OUT, 'feed');
  const cases = buildFeed({
    outDir: feedDir,
    newVersion: process.env.QA_FEED_VERSION || '999.0.0',
    downgradeVersion: '0.0.1',
    artifactPath: resolved.kind === 'appimage' && fs.statSync(path.resolve(TARGET)).isFile() ? path.resolve(TARGET) : null,
  });
  // Self-verify: recompute digests from the served files.
  for (const [name, c] of Object.entries(cases)) {
    const yml = fs.readFileSync(c.ymlPath, 'utf8');
    const declared = /sha512: (\S+)/.exec(yml)[1];
    const bytes = fs.readFileSync(c.artifactPath);
    const real = (await import('node:crypto')).createHash('sha512').update(bytes).digest('base64');
    const match = declared === real;
    if (name === 'error' && match) throw new Error('tampered case declared == real digest — generator broken');
    if (name !== 'error' && !match) throw new Error(`${name} case digest mismatch — generator broken`);
    if (bytes.length !== c.size) throw new Error(`${name} size mismatch`);
  }
  const feed = await serveFeed(feedDir, FEED_PORT);
  feed.cases = cases;
  ctx.feed = feed;
  const h = await fetch(`http://127.0.0.1:${feed.port}/available/latest-linux.yml`);
  if (!h.ok) throw new Error('feed server not serving latest-linux.yml');
  const evidence = Object.values(cases).map((c) => c.ymlPath);
  return { detail: `${Object.keys(cases).length} cases built (available=${cases.available.version}, tampered digest differs as designed); feed on :${feed.port}`, evidence };
});

// ------------------------------------------------------- updater scenarios
async function updaterRun(caseName, { withQaEnv = true } = {}) {
  const { main } = ctx;
  const fpBefore = installFingerprint(TARGET);
  const beforeAccess = ctx.feed.accessLog.length;
  const env = baseEnv(fs.mkdtempSync(path.join(PROFILES, `upd-${caseName}-`)));
  if (withQaEnv) {
    env.PLOTINA_QA_UPDATES = '1';
    env.PLOTINA_UPDATE_FEED_URL = `http://127.0.0.1:${ctx.feed.port}/${caseName}/`;
  } else {
    env.PLOTINA_UPDATE_FEED_URL = `http://127.0.0.1:${ctx.feed.port}/available/`; // gate closed
  }
  delete env.LITE_ECHO_CONSOLE;
  const label = `upd-${caseName}${withQaEnv ? '' : '-gated'}`;
  const handle = launchApp(resolved, { label, logFile: path.join(LOGS, `${label}-${Date.now()}.log`), redact, env, args: [] });
  await sleep(OBSERVE_MS);
  const stillAlive = !handle.exited;
  const queries = ctx.feed.accessLog.slice(beforeAccess).filter((r) => r.url.includes(`/${caseName.replace('-gated', '')}/`));
  if (ctx.updaterPresent === null) ctx.updaterPresent = queries.length > 0;
  let logSays = null;
  const txt = handle.logText();
  if (/up.to.date|no update/i.test(txt)) logSays = 'up-to-date';
  else if (/update available|found version|new version/i.test(txt)) logSays = 'update-available';
  else if (/sha512|checksum|signature|invalid|refus/i.test(txt)) logSays = 'verify-error';
  killApp(handle);
  await handle.waitForExit(15000).catch(() => {});
  const fpAfter = installFingerprint(TARGET);
  return { handle, stillAlive, queries, logSays, fpChanged: fpBefore !== fpAfter, txt };
}

const updaterSkipIfAbsent = (caseName, r) => {
  if (r.queries.length === 0) {
    return {
      status: 'skip',
      reason: `shell never queried the local feed for ${caseName} with PLOTINA_QA_UPDATES=1 — updater hooks not implemented in this build (matrix blocker B3 open). Feed fixtures (U-00) and install-fingerprint check did run.`,
    };
  }
  return null;
};

scenario({ id: 'U-02', name: 'updater no-update: feed offers only 0.0.1 → must not download/offer', matrix: ['U-02', 'U-08'], priority: 'P0' }, async () => {
  const r = await updaterRun('no-update');
  const skip = updaterSkipIfAbsent('no-update', r);
  if (skip) return skip;
  if (r.fpChanged) throw new Error('install fingerprint changed during a no-update check!');
  const dl = r.queries.some((q) => q.url.endsWith('.AppImage'));
  if (dl) throw new Error('app DOWNLOADED the downgrade/no-update artifact');
  return { detail: `feed queried ${r.queries.length}x, artifact not downloaded, install unchanged; log said '${r.logSays || '(nothing update-specific)'}'` };
});

scenario({ id: 'U-03', name: 'updater update-available: feed offers 999.0.0 with valid sha512', matrix: ['U-03'], priority: 'P0' }, async () => {
  const r = await updaterRun('available');
  const skip = updaterSkipIfAbsent('available', r);
  if (skip) return skip;
  if (r.fpChanged) throw new Error('install replaced without user install action');
  if (!r.stillAlive) throw new Error('app crashed when the feed advertised an update');
  return { detail: `feed queried; update advertised (log '${r.logSays}'); install untouched until user confirms` };
});

scenario({ id: 'U-05', name: 'updater bad-metadata: tampered sha512 must be refused, install preserved', matrix: ['U-05'], priority: 'P0' }, async () => {
  const r = await updaterRun('error');
  const skip = updaterSkipIfAbsent('error', r);
  if (skip) return skip;
  const gotArtifact = r.queries.some((q) => q.url.endsWith('.AppImage'));
  if (gotArtifact && !/verify-error/.test(r.logSays || '')) {
    rec.note('error case: artifact was fetched — verification outcome must show refusal in the log');
  }
  if (r.fpChanged) throw new Error('HARD FAIL: install replaced despite tampered sha512');
  if (!r.stillAlive) throw new Error('app crashed on malformed/tampered feed metadata');
  const refused = r.logSays === 'verify-error';
  return {
    status: refused ? 'pass' : 'fail',
    detail: `feed queried; install ${r.fpChanged ? 'REPLACED' : 'preserved'}; log ${refused ? 'shows verification refusal' : 'shows NO checksum-refusal message (needs product work: refuse + report)'}`,
  };
});

scenario({ id: 'U-07', name: 'QA feed gate: without PLOTINA_QA_UPDATES=1 the app must ignore PLOTINA_UPDATE_FEED_URL', matrix: ['U-01', 'R-06'], priority: 'P1' }, async () => {
  if (ctx.updaterPresent === false) {
    return { status: 'skip', reason: 'updater not present in this build — gate assertion only meaningful once PLOTINA_QA_UPDATES is implemented (B3)' };
  }
  const r = await updaterRun('available', { withQaEnv: false });
  if (r.queries.length > 0) throw new Error('app consulted a QA feed URL WITHOUT the PLOTINA_QA_UPDATES gate — production builds must ignore it');
  return { detail: 'PLOTINA_UPDATE_FEED_URL without gate: zero feed requests; install unchanged' };
});

// --------------------------------------------------------------------- run
console.log(`regression harness: target=${TARGET} kind=${resolved.kind} out=${OUT} cdp=${CDP_PORT} feed=${FEED_PORT}`);
let chainBroken = null;
for (const { meta, fn } of scenarios) {
  const needsMain = !['U-00'].includes(meta.id);
  if (needsMain && meta.id !== 'L-01' && (!ctx.main || ctx.main.handle.exited)) {
    try { await ensureMain(); } catch (e) { chainBroken = e.message; }
  }
  if (chainBroken && needsMain && meta.id !== 'U-00') {
    rec.checks.push({ id: meta.id, name: meta.name, matrix: meta.matrix, priority: meta.priority, status: 'skip', detail: '', reason: `skipped after earlier launch failure: ${chainBroken}`, evidence: [], durationMs: 0 });
    continue;
  }
  const out = await rec.run(meta, fn, ctx);
  if (out.status === 'fail' && ['L-01'].includes(meta.id)) chainBroken = out.detail;
}

// final grace: capture a failure shot if app is still up and something failed
try {
  if (ctx.main && !ctx.main.handle.exited && rec.summary().fail > 0) {
    await ctx.main.cdp.screenshot(path.join(SHOTS, '99-final-state.png'));
  }
} catch { /* ignore */ }

await killMain(false);
if (ctx.feed) { try { ctx.feed.server.close(); } catch { /* ignore */ } }
// token hygiene: profiles (Chromium localStorage) are wiped with the run,
// never shipped inside the evidence dir.
try { fs.rmSync(PROFILES, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(path.join(OUT, 'profiles'), { recursive: true, force: true }); } catch { /* ignore */ }

const md = rec.writeMarkdown();
clearTimeout(watchdog);
console.log('\n================ RESULT SUMMARY ================');
console.log(md.split('\n').slice(0, 12).join('\n'));
console.log(`\nresults.json: ${path.join(OUT, 'results.json')}`);
console.log(`REPORT.md:    ${path.join(OUT, 'REPORT.md')}`);
const code = rec.summary().fail > 0 ? 1 : 0;
process.exit(code);
