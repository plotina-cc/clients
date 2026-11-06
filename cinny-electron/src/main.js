// Plotina Lite Desktop - Electron main process (Phase 1 prototype).
'use strict';

const { app, BrowserWindow, session, shell, screen, Tray, Menu, desktopCapturer } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createAppServer } = require('./app-server');

const APP_TITLE = 'Plotina Lite Desktop';
if (process.env.LITE_USER_DATA) {
  app.setPath('userData', process.env.LITE_USER_DATA); // QA runs get isolated profiles
}
const PROTOCOL = 'cc.plotina.chat';
const SSO_LOGIN_TOKEN_MESSAGE = 'plotina:sso:login-token'; // matches cinny patch 0007
// Preferred port so the origin (and with it localStorage/IndexedDB/
// permissions) stays stable across runs; mirrors the old
// tauri-plugin-localhost origin http://localhost:44548. If the port is taken
// (e.g. a second instance running for QA) we fall back to an ephemeral one -
// everything downstream reads the live `appOrigin` instead of this constant.
const PORT = Number(process.env.LITE_PORT || 44548);
const DIST = process.env.LITE_DIST || '/home/hermes/build/cinny-desktop/cinny/dist';
let appOrigin = null; // set after the server listens
// Origins allowed to reach camera/microphone: our bundled app origin and the
// embedded Element Call iframe. Exact-origin matching, same policy as the
// Tauri shell's linux_media.rs (deny-by-default, allowlist).
const allowsMediaOrigin = (origin) =>
  origin !== '' && (origin === appOrigin || origin === 'https://call.plotina.cc');
// We use 127.0.0.1 rather than "localhost" as the origin host: "localhost"
// resolves to ::1 as well, and a stray second server on [::1]:44548 (seen on
// shared QA hosts) can then serve the window different content. 127.0.0.1
// only ever hits our own embedded server.
const ORIGIN_HOST = '127.0.0.1';
const HOMESERVER_LOGIN_URL = /^https?:\/\/plotina\.cc\/_matrix\/client\/[^/]+\/login(\?|$)/;

let server = null;
let mainWindow = null;
let tray = null;
const pendingDeepLinks = [];

// ---------------------------------------------------------------- window state
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    if (typeof s.width !== 'number' || typeof s.height !== 'number') return null;
    if (typeof s.x === 'number' && typeof s.y === 'number') {
      const onScreen = screen.getAllDisplays().some((d) =>
        d.bounds.x <= s.x && s.x < d.bounds.x + d.bounds.width &&
        d.bounds.y <= s.y && s.y < d.bounds.y + d.bounds.height);
      if (!onScreen) return { width: s.width, height: s.height }; // state from a detached monitor
    }
    return s;
  } catch { return null; }
}

function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const data = { ...bounds, maximized: win.isMaximized() };
    fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify(data));
  } catch (e) { console.error('window-state save failed:', e); }
}

// --------------------------------------------------------------- deep links
function extractDeepLink(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`)) || null;
}

function loginTokenFromUrl(raw) {
  // Accept both ?loginToken=.. and #..&loginToken=.. (or #loginToken=..)
  // forms, matching the Tauri shell's callback predicate.
  try {
    const u = new URL(raw);
    const fromQuery = u.searchParams.get('loginToken');
    if (fromQuery) return fromQuery;
    const h = u.hash.replace(/^#/, '');
    const qs = h.includes('?')
      ? h.slice(h.lastIndexOf('?') + 1)
      : h.includes('=') && !h.startsWith('/') ? h : '';
    return new URLSearchParams(qs).get('loginToken');
  } catch { return null; }
}

// Send a loginToken to the app's Login page without needing an opener link
// (the minimal alternative when the token arrives via deep link / second
// instance). The patched web app listens for exactly this MessageEvent.
function handoffLoginToken(token, via) {
  if (!mainWindow || mainWindow.isDestroyed() || !token) return false;
  const js = `window.dispatchEvent(new MessageEvent('message', {
    data: { type: ${JSON.stringify(SSO_LOGIN_TOKEN_MESSAGE)}, loginToken: ${JSON.stringify(token)} },
    origin: ${JSON.stringify(appOrigin)},
  }))`;
  mainWindow.webContents.executeJavaScript(js).then(
    () => console.log(`[sso] handed loginToken via ${via} to renderer`),
    (e) => console.error(`[sso] handoff via ${via} failed:`, e),
  );
  return true;
}

// -------------------------------------------------------------- sign-in flow
function isAppOrigin(raw) {
  try { return new URL(raw).origin === appOrigin; } catch { return false; }
}

function hasCallbackToken(raw) {
  if (!isAppOrigin(raw)) return false;
  return !!loginTokenFromUrl(raw); // query or fragment, like the Tauri predicate
}

function attachSignInWindowGuards(contents) {
  // The child stays on whatever page the IdP wants; only the final callback
  // back into our app origin (carrying loginToken) triggers the self-close,
  // mirroring Tauri patch 0002 so the popup does not sit on the callback page.
  const startCloseWatch = (url) => {
    if (!hasCallbackToken(url)) return;
    // A fixed timer (1300ms, like the Tauri webview) loses a race in
    // Electron: each window.open child is a *cold* renderer that must download
    // + eval the 3.8MB bundle, mount React, and run the handoff effect before
    // we may close, or the token never reaches the opener. Instead, poll the
    // child until the patched page renders its success text (the same branch
    // that posts the token to window.opener) and close shortly after; 8s cap
    // guards against a page that never boots.
    const started = Date.now();
    const tick = async () => {
      if (contents.isDestroyed()) return;
      let ready = false;
      try {
        ready = await contents.executeJavaScript(
          `!!(document.body && document.body.textContent.includes('Sign-in complete'))`);
      } catch { /* navigating */ }
      if (ready) {
        setTimeout(() => { if (!contents.isDestroyed()) contents.close(); }, 250);
        console.log(`[sso] sign-in window handing over token (${Date.now() - started}ms)`);
        return;
      }
      if (Date.now() - started > 8000) {
        console.log('[sso] sign-in window did not complete handoff in 8s; closing anyway');
        if (!contents.isDestroyed()) contents.close();
        return;
      }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 400);
  };
  contents.on('did-navigate', (_e, url) => startCloseWatch(url));
  contents.on('did-navigate-in-page', (_e, url) => startCloseWatch(url));
}

// Intercept the "Continue with <IdP>" navigation on the main window: Matrix
// SSO login URLs must run in a child window that keeps a real opener link
// (patch 0007 posts the loginToken to window.opener).
function wireSSOInterception(win) {
  const wc = win.webContents;
  wc.on('will-navigate', (event, url) => {
    if (isAppOrigin(url)) return; // internal routing
    if (HOMESERVER_LOGIN_URL.test(url)) {
      event.preventDefault();
      // Open through the *renderer*'s window.open so Electron's native
      // window-open gives the child a genuine window.opener + postMessage
      // channel; a main-process `new BrowserWindow` would have none.
      wc.executeJavaScript(`window.open(${JSON.stringify(url)}, '_blank', 'width=520,height=720')`)
        .catch((e) => console.error('[sso] open sign-in window failed:', e));
      return;
    }
    // Everything else leaves the app and goes to the OS browser.
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  wc.setWindowOpenHandler(({ url }) => {
    console.log(`[window-open] ${url}`);
    if (isAppOrigin(url)) {
      console.log('[window-open] allow (app origin)');
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          title: `${APP_TITLE} - Sign in`,
          webPreferences: { sandbox: true },
        },
      };
    }
    if (/^https?:\/\//.test(url)) {
      // A top-level popup to an external site: hand it to the OS browser.
      // (SSO children are allowed by the branch above and keep their own
      // default window-open behaviour.)
      console.log('[window-open] external -> shell.openExternal');
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    console.log('[window-open] deny (non-http)');
    return { action: 'deny' };
  });

  // Guards for every child window this contents opens.
  wc.on('did-create-window', (childWin) => {
    console.log('[window-open] child created:', childWin.webContents.getURL());
    attachSignInWindowGuards(childWin.webContents);
    if (process.env.LITE_ECHO_CONSOLE === '1') echoConsole(childWin.webContents);
  });
}

function echoConsole(wc) {
  // Electron >=34 hands an event object (level is a string); older releases
  // pass positional args. Support both.
  wc.on('console-message', (event, level, message, line, sourceId) => {
    const e = event || {};
    console.log(`[renderer:${e.level ?? level ?? ''}] ${e.message ?? message ?? ''} (${e.sourceId ?? sourceId ?? ''}:${e.lineNumber ?? e.line ?? 0})`);
  });
}

// ------------------------------------------------------------------ window
function createMainWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state?.x, y: state?.y,
    width: state?.width || 1200,
    height: state?.height || 800,
    minWidth: 800,
    minHeight: 560,
    title: APP_TITLE,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'), // black/graphite Cinny icon
    backgroundColor: '#101016',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  win.setTitle(APP_TITLE);
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(APP_TITLE); });
  if (state?.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  win.on('close', () => saveWindowState(win));
  let saveTimer = null;
  const debouncedSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 500);
  };
  // 'resize'/'move' fire for every bounds change including scripted ones and
  // second-instance focus; 'resized'/'moved' only fire on user interaction.
  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('closed', () => saveWindowState(win)); // best-effort (may be post-destroy)
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  wireSSOInterception(win);

  if (process.env.LITE_ECHO_CONSOLE === '1') {
    echoConsole(win.webContents);
  }

  win.loadURL(`${appOrigin}/`);

  // flush deep links that arrived before the first window existed
  while (pendingDeepLinks.length) {
    const url = pendingDeepLinks.shift();
    const token = loginTokenFromUrl(url);
    if (token) handoffLoginToken(token, 'startup-deeplink');
    win.focus();
  }
  return win;
}

// ------------------------------------------------------------------ session
function configurePermissions(session) {
  const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };

  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    switch (permission) {
      case 'media': return allowsMediaOrigin(requestingOrigin);
      case 'display-capture': return allowsMediaOrigin(requestingOrigin);
      case 'notifications': return requestingOrigin === appOrigin;
      case 'clipboard-sanitized-write': return requestingOrigin === appOrigin;
      case 'fullscreen': return true;
      default: return false;
    }
  });

  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = originOf(details.requestingUrl || '');
    switch (permission) {
      case 'media': // getUserMedia (camera/microphone)
        return callback(allowsMediaOrigin(origin));
      case 'display-capture':
        return callback(allowsMediaOrigin(origin));
      case 'notifications':
        return callback(origin === appOrigin);
      case 'clipboard-sanitized-write':
        return callback(origin === appOrigin);
      case 'fullscreen':
        return callback(true);
      default:
        console.log(`[permissions] denied '${permission}' for ${origin}`);
        return callback(false);
    }
  });

  // Screen sharing: Chromium asks Electron for a source; we feed it the
  // desktopCapturer list (whole screen) for allowlisted origins only.
  session.setDisplayMediaRequestHandler(async (params, callback) => {
    const origin = originOf(params.securityOrigin || params.frame?.url || '');
    if (!allowsMediaOrigin(origin)) return callback({});
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      window: BrowserWindow.getAllWindows()[0],
    });
    if (!sources.length) return callback({});
    callback({ video: sources[0], audio: params.mediaTypes?.includes('audio') ? sources[0] : undefined });
  }, { useSystemPicker: false });
}

// ------------------------------------------------------------------- boot
// Single-instance policy: Electron's default Linux argv forwarding rewrites
// the command line, so the cc.plotina.chat:// URL alone may never reach the
// holder (observed in testing); a non-holder instance drops it into the
// file inbox below instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Second instance: Linux argv forwarding rewrites the command line (and
  // ignores additionalArguments), so a deep link can never reach the holder
  // that way. Drop the URL into a file inbox under userData; the holder
  // polls it. (Packaged builds get the URL as a real argv entry via the
  // registered .desktop %U handler, and the extractDeepLink/second-instance
  // path above covers that.)
  const inboxDir = path.join(app.getPath('userData'), 'deep-link-inbox');
  try {
    fs.mkdirSync(inboxDir, { recursive: true });
    const url = extractDeepLink(process.argv);
    if (url) {
      fs.writeFileSync(path.join(inboxDir, `${Date.now()}-${process.pid}.url`), url);
    }
  } catch (e) { console.error('[main] inbox write failed:', e.message); }
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    console.log('[main] second-instance:', argv.join(' '));
    // Electron's Linux argv forwarding rewrites the loser's argv (extra
    // switches, stripped args), so a deep link can arrive mangled or not at
    // all. The loser below re-signals the link explicitly via --sso-token;
    // check both sources.
    const url = extractDeepLink(argv);
    const markerIdx = argv.indexOf('--sso-token');
    const markerToken = markerIdx >= 0 ? argv[markerIdx + 1] : null;
    const token = (url && loginTokenFromUrl(url)) || markerToken;
    if (token) handoffLoginToken(token, url ? 'deep-link' : 'deep-link-marker');
    else if (url) console.log('[main] second-instance URL had no loginToken:', url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-url', (event, url) => { // macOS deep links
    event.preventDefault();
    if (mainWindow) { const t = loginTokenFromUrl(url); if (t) handoffLoginToken(t, 'open-url'); }
    else pendingDeepLinks.push(url);
  });

  process.on('uncaughtException', (e) => console.error('[main] uncaught:', e));

  app.whenReady().then(async () => {
    app.setName('Plotina Lite');
    app.setAppUserModelId('cc.plotina.chat');

    configurePermissions(session.defaultSession);

    server = createAppServer(DIST);
    await new Promise((resolve, reject) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && PORT !== 0) {
          console.log(`[lite] port ${PORT} busy; using an ephemeral port instead`);
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        } else {
          reject(err);
        }
      });
      server.listen(PORT, '127.0.0.1', resolve);
    });
    appOrigin = `http://${ORIGIN_HOST}:${server.address().port}`;
    console.log(`[lite] serving ${DIST} at ${appOrigin}`);

    // Deep link protocol: registered with the running binary when unpackaged.
    const registered = app.setAsDefaultProtocolClient(
      PROTOCOL,
      process.execPath,
      app.isPackaged ? undefined : [path.resolve(__dirname, '..')],
    );
    console.log(`[lite] protocol ${PROTOCOL}:// registered=${registered}`);

    // Cold-start deep link (Linux passes it as an argv entry).
    const initial = extractDeepLink(process.argv);
    if (initial) pendingDeepLinks.push(initial);

    if (process.env.LITE_TRAY === '1') {
      try {
        tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png'));
        tray.setToolTip(APP_TITLE);
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: 'Show', click: () => mainWindow?.show() },
          { type: 'separator' },
          { label: 'Quit', click: () => app.quit() },
        ]));
        tray.on('click', () => mainWindow?.show());
      } catch (e) { console.log('[lite] tray unavailable:', e.message); }
    }

    createMainWindow();

    // Deep-link inbox written by second instances (see above).
    const inboxDir = path.join(app.getPath('userData'), 'deep-link-inbox');
    try { fs.mkdirSync(inboxDir, { recursive: true }); } catch { /* exists */ }
    setInterval(() => {
      let files = [];
      try { files = fs.readdirSync(inboxDir); } catch { return; }
      for (const f of files) {
        const full = path.join(inboxDir, f);
        let url = '';
        try { url = fs.readFileSync(full, 'utf8').trim(); } catch { /* partial */ }
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        if (!url) continue;
        console.log('[main] inbox deep link:', url.replace(/loginToken=.*/, 'loginToken=<redacted>'));
        const token = loginTokenFromUrl(url);
        if (token && mainWindow) handoffLoginToken(token, 'deep-link-inbox');
      }
    }, 300);

    app.on('activate', () => {
      if (!mainWindow) createMainWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    // some shutdown paths (CDP Browser.close, SIGTERM-handled quits) skip the
    // window 'close' event; make sure state is not lost.
    saveWindowState(mainWindow);
  });
}
