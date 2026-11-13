// Plotina Lite Desktop - Electron main process (Phase 2: packaged shell:
// web dist bundled in the asar, installer identity, updater).
'use strict';

const { app, BrowserWindow, session, shell, screen, Tray, Menu, ipcMain, desktopCapturer, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createAppServer } = require('./app-server');
const { createDisplayMediaRequestHandler } = require('./display-media');
const updater = require('./updater');
const { UI_TEXT } = require('./update-channel');

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
// The fixed port is a preference, not a hard requirement, because every
// consumer reads `appOrigin` from the server's real address.
const PORT = Number(process.env.LITE_PORT || 44548);
// Packaged builds serve the Cinny web dist bundled inside the app's asar
// (web/, staged by scripts/stage-web.sh before electron-builder runs). The
// env override keeps dev/QA able to point at a live dist directory.
const DIST = process.env.LITE_DIST ||
  (app.isPackaged ? path.join(__dirname, '..', 'web') : '/home/hermes/build/cinny-desktop/cinny/dist');
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
// Matrix SSO is not a single /login URL: Synapse redirects to
// /login/sso/redirect, and the web app may open either that URL or an
// /auth/... URL in a popup. Match the whole auth surface, not just /login.
function isHomeserverLoginUrl(raw) {
  try {
    const u = new URL(raw);
    return u.hostname === 'plotina.cc' &&
      u.pathname.startsWith('/_matrix/client/') &&
      (/\/login(?:\/|$)/.test(u.pathname) || u.pathname.includes('/auth/'));
  } catch { return false; }
}

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
    if (isHomeserverLoginUrl(url)) {
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
    if (isHomeserverLoginUrl(url)) {
      // Keep the SSO popup inside Electron so it retains window.opener; a
      // system browser has no opener and the patched login page cannot post
      // the loginToken back into the app.
      console.log('[window-open] allow (homeserver SSO)');
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
      // (SSO children are handled above and keep their own opener.)
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
// X11 window-icon cap: Chromium serialises _NET_WM_ICON through ONE
// XChangeProperty request (w*h*4 + 8 CARDINALs). A 256 px icon needs
// 262,152 B and exceeds the 262,140 B X protocol limit — the server answers
// BadLength and KDE falls back to a generic icon. 128 px fits (65,544 B).
// Same rule as element-desktop/desktop/icon.ts. The launcher/taskbar icon
// still comes from the hicolor theme via StartupWMClass, not from here.
const MAX_X11_WINDOW_ICON_PX = 128;
function iconAssetPath() {
  // nativeImage cannot read from inside app.asar reliably; electron-builder
  // copies this file to resources/icon.png (extraResources).
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', 'assets', 'icon.png');
}

function getMainWindowIcon() {
  const iconPath = iconAssetPath();
  if (process.platform !== 'linux') return iconPath; // Windows: .ico lives in the installer
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return iconPath;
  const { width, height } = image.getSize();
  if (width <= MAX_X11_WINDOW_ICON_PX && height <= MAX_X11_WINDOW_ICON_PX) return image;
  return image.resize({ width: MAX_X11_WINDOW_ICON_PX, height: MAX_X11_WINDOW_ICON_PX });
}

// ------------------------------------------------- updates menu / channel UI
// The Settings entry for the update channel. The bundled Cinny dist is a
// prebuilt artifact (patching it is a separate change), so the entry lives in
// the shell menu today — application menu always, tray menu when LITE_TRAY=1 —
// and the same contract is exposed to the renderer through preload
// (plotinaLite.updater.channel), so a web Settings page can host it later.
// Dev is opt-in and gated behind the warning dialog; the radio items are
// rebuilt from the live updater state after every change.
async function chooseChannel(next) {
  const before = updater.channelState();
  if (next === before.channel) return before;
  if (next === 'dev') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: UI_TEXT.devWarningTitle,
      message: UI_TEXT.devWarningMessage,
      detail: UI_TEXT.devWarningDetail,
      buttons: UI_TEXT.devWarningButtons,
      defaultId: 0, cancelId: 1, noLink: true,
    });
    if (response !== 0) { refreshAppMenu(); return before; } // radio snaps back
  }
  const res = updater.setChannel(next, { acknowledged: true });
  if (!res.ok) console.warn('[menu] channel change refused:', res.error || `needs confirmation (${next})`);
  refreshAppMenu();
  return res.state || updater.channelState();
}

function updatesSubmenu() {
  const st = updater.channelState();
  const items = [
    { label: UI_TEXT.checkForUpdates, click: () => { void updater.runCheck(true); } },
    { type: 'separator' },
    {
      label: UI_TEXT.channelEntry(st.channel), // 'Канал обновлений: Стабильный'
      enabled: st.selfUpdate,
      submenu: [
        { label: UI_TEXT.stableLabel, type: 'radio',
          checked: st.channel === 'stable', click: () => { void chooseChannel('stable'); } },
        { label: UI_TEXT.devLabel, type: 'radio',
          checked: st.channel === 'dev', click: () => { void chooseChannel('dev'); } },
        { type: 'separator' },
        { label: UI_TEXT.returnToStable, enabled: st.channel === 'dev',
          click: () => { void updater.returnToStable({ manual: true }); } },
      ],
    },
  ];
  if (!st.selfUpdate) items.push({ label: UI_TEXT.manualKindsNote, enabled: false });
  return items;
}

function menuTemplate() {
  // Standard roles first (copy/paste/zoom must keep working in the chat), then
  // our Updates menu. Roles are Electron-localized; the channel strings come
  // from src/update-channel.js (UI_TEXT).
  const template = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });
  template.push(
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: UI_TEXT.updatesMenu, submenu: updatesSubmenu() },
  );
  return template;
}

function trayTemplate() {
  return [
    { label: 'Show', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: UI_TEXT.updatesMenu, submenu: updatesSubmenu() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ];
}

function refreshAppMenu() {
  try { Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate())); }
  catch (e) { console.warn('[menu] application menu failed:', e.message); }
  if (tray) { try { tray.setContextMenu(Menu.buildFromTemplate(trayTemplate())); } catch { /* tray gone */ } }
}

// Real packaged version (e.g. 4.12.8-plotina.23 or 4.12.8-plotina.23-dev.1)
// for the Settings -> Updates page. app.getVersion() is the electron-builder
// stamped value; the web bundle's own version string must not be trusted.
ipcMain.handle('plotina:app-version', () => app.getVersion());

// Tray: the same black mark; Electron/GTK scales it to the panel. The
// light/dark variant selection from the migration plan (§5.2) stays with the
// tray's LITE_TRAY opt-in path, unproven in Phase 2.
function getTrayIconPath() {
  return iconAssetPath();
}

function createMainWindow() {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state?.x, y: state?.y,
    width: state?.width || 1200,
    height: state?.height || 800,
    minWidth: 800,
    minHeight: 560,
    title: APP_TITLE,
    icon: getMainWindowIcon(), // black/graphite Cinny icon (<=128 px on Linux)
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
  //
  // The handler must answer every request exactly once: a cancelled system /
  // portal picker (or any desktopCapturer failure) used to leave Chromium's
  // request pending, and while one request is pending every later
  // getDisplayMedia() in the app silently waits behind it — "Share screen does
  // nothing, no picker" until restart. See src/display-media.js.
  //
  // Do not return a screen source as `audio`: Electron rejects
  // getDisplayMedia({video:true, audio:{...}}) with AbortError "Invalid capture
  // constraints" and Element Call always requests screen audio, so passing the
  // screen source there broke screen sharing on Linux and Windows. Video-only
  // screen capture is accepted for the same request.
  session.setDisplayMediaRequestHandler(
    createDisplayMediaRequestHandler({
      // `window` keeps HiDPI scaling consistent with the window we render in.
      getSources: (opts) => desktopCapturer.getSources({ ...opts, window: BrowserWindow.getAllWindows()[0] }),
      isOriginAllowed: allowsMediaOrigin,
      log: (msg) => console.log(msg),
    }),
    { useSystemPicker: false },
  );
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
    app.setName(APP_TITLE); // userData dir becomes 'Plotina Lite Desktop' (plan §5.2)
    app.setAppUserModelId('cc.plotina.chat');
    if (app.isPackaged && process.platform === 'linux') {
      // Notification identity on Linux: without this, toasts show "Electron".
      // Name must match the installed .desktop file (electron-builder derives
      // it from executableName: plotina-lite-desktop.desktop).
      try { app.setDesktopName('plotina-lite-desktop.desktop'); } catch { /* older Electron ignores */ }
    }

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

    // Deep link protocol. electron-builder's `protocols` config registers
    // cc.plotina.chat + matrix through the packaged .desktop MimeType
    // (deb/rpm) and the Windows registry (NSIS/MSI). Calling
    // setAsDefaultProtocolClient from a PACKAGED Linux build is wrong:
    // from an AppImage it would register the temporary mount path. Only
    // Windows (registry, harmless) and the unpackaged dev build need this.
    let registered = 'desktop-entry(packaged)';
    if (!app.isPackaged || process.platform === 'win32') {
      registered = String(app.setAsDefaultProtocolClient(
        PROTOCOL,
        process.execPath,
        app.isPackaged ? undefined : [path.resolve(__dirname, '..')],
      ));
    }
    console.log(`[lite] protocol ${PROTOCOL}:// registered=${registered}`);

    // Cold-start deep link (Linux passes it as an argv entry).
    const initial = extractDeepLink(process.argv);
    if (initial) pendingDeepLinks.push(initial);

    if (process.env.LITE_TRAY === '1') {
      try {
        tray = new Tray(getTrayIconPath());
        tray.setToolTip(APP_TITLE);
        tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
        tray.on('click', () => mainWindow?.show());
      } catch (e) { console.log('[lite] tray unavailable:', e.message); }
    }

    createMainWindow();
    // Application menu (carries the update-channel entry) + the updater, which
    // asks for a menu rebuild whenever the channel actually changes.
    refreshAppMenu();
    updater.init(() => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
      { onChannelChange: () => refreshAppMenu() });

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
