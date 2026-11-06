# Plotina Lite Desktop — Electron shell (Phase 1 prototype)

Electron main/preload that loads the existing Cinny web build
(`cinny/scripts/build.sh` output), replacing the Tauri shell so calls work:
WebKitGTK distro builds lack WebRTC, Chromium has it. No installer/updater yet
(Phase 2); `element-desktop/` + element-web `apps/desktop` are the reference
for that.

## Layout

```
cinny-electron/
  package.json          # electron pinned 44.4.5 (= element-desktop's pin)
  src/main.js           # window, SSO, permissions, deep links, state
  src/preload.js        # sandboxed contextBridge metadata (no IPC needed yet)
  src/app-server.js     # static localhost server for the Cinny dist
  scripts/qa.mjs        # full acceptance harness (CDP, no deps)
  scripts/debug-*.mjs   # targeted probes used while building this
  assets/               # icons copied from cinny/icons (black/graphite Cinny)
```

## Run

```bash
npm install                     # electron binary comes from ~/.cache/electron
npm start                       # uses LITE_DIST default below
xvfb-run -a -s "-screen 0 1440x900x24" node scripts/qa.mjs   # full proof
```

Serves `LITE_DIST` (default `/home/hermes/build/cinny-desktop/cinny/dist`).
That dist is built by the existing `cinny/scripts/build.sh` (upstream v4.12.8
+ `patches/0007` chain); the current build already embeds the patch markers
(`plotina:sso:login-token`, "Sign-in complete…" strings verified inside
`dist/assets/index-*.js`). Rebuilding on this host is blocked by the agent
approval rule ("builds belong on the laptop or GitHub CI"), so QA pins a
frozen copy (`/home/hermes/.hermes/cache/scratch/cinny-dist-backup`) because
the shared dist dir gets rebuilt by other sessions mid-run.

## Architecture decisions

**Serving: embedded localhost HTTP server, not a custom scheme.**
`plotina-lite://app/` was rejected because (1) Chromium only registers Service
Workers on http(s) origins and Cinny registers `sw.js` for push/session;
(2) `file://` breaks Cinny's path-based routing (hashRouter disabled in
`config.json`) and the SW scope. `http://127.0.0.1:<port>` is a trustworthy
secure context → getUserMedia/WebRTC work, deep links like `/home/<room>/`
resolve via SPA fallback. This mirrors the Tauri shell's tauri-plugin-localhost
(origin `http://localhost:44548`). **`127.0.0.1` not `localhost`**: another
process may bind `[::1]:44548` (happened on this shared QA host) and the page
would silently get mixed content. Port preference 44548 (`LITE_PORT`),
automatic ephemeral fallback when busy.

**SSO: preserve the real opener link.** The patched web app (patch 0007)
completes SSO by having the callback popup `window.opener.postMessage` the
`loginToken` to the login page. Electron ≥29's `window.open` creates a child
BrowserWindow that keeps a genuine opener/openee relationship — verified
(`debug-opener.mjs`: `window.opener` non-null, cross-window postMessage
delivered with correct origin). So: main intercepts `will-navigate` on
`https://plotina.cc/_matrix/client/*/login…`, preventDefault, and re-runs the
navigation as the renderer's own `window.open` (`setWindowOpenHandler` allows
app-origin URLs). No credentials touch the prototype; QA proves the whole
chain with a synthetic token (popup → opener → parent initiates
`m.login.token` exchange → HS rejects the fake token, as expected).

**Sign-in popup auto-close must be readiness-aware.** Tauri's fixed 1300ms
timer is wrong for Electron: every `window.open` child is a cold renderer
(3.8MB bundle eval + React mount), and closing before the effect posts loses
the token. The shell polls the child for its "Sign-in complete" text and
closes 250ms later (8s cap). Observed handoff at ~3.9s.

**Deep links (`cc.plotina.chat://`).** Registered via
`setAsDefaultProtocolClient` (returns false in dev here — no .desktop
integration until packaging; electron-builder `protocols` is the Phase 2 fix).
Linux second-instance argv forwarding rewrites/mangles the command line —
the URL was observed dropped entirely (`debug-deeplink.mjs`), and
`additionalArguments` are ignored. Minimal robust alternative implemented: the
non-holder instance writes the URL to `<userData>/deep-link-inbox/`, the holder
polls it and dispatches the same `plotina:sso:login-token` `MessageEvent` into
the page (matching patch 0007's listener). Proven with synthetic `SYN_2`.

**Calls/permissions.** Deny-by-default `setPermissionRequestHandler` +
`setPermissionCheckHandler`: `media`/`display-capture` allowed only for exact
origins `appOrigin` and `https://call.plotina.cc` (embedded Element Call),
`notifications`/clipboard-write for app origin only — same policy shape as the
Tauri `linux_media.rs`. `setDisplayMediaRequestHandler` feeds the screen via
`desktopCapturer` for allowlisted origins. QA (fake media flags) proves:
`typeof RTCPeerConnection === 'function'`, working audio+video SDP offer,
`getUserMedia` + `enumerateDevices`, and `getDisplayMedia` resolving.

**Window.** Title locked to `Plotina Lite Desktop` (page-title overrides
prevented), black/graphite Cinny icon (`assets/icon.png`), bounds + maximized
persisted to `<userData>/window-state.json` (save on close/resize/move
events; scripted `resizeTo` fires `resize` but not `resized`, and
`window.close()` skips `close` — bound accordingly; save/restore verified in
`debug-windowstate.mjs`). Single-instance lock with focus-on-relaunch.
External links: non-app `will-navigate`/`window.open` → `shell.openExternal`,
never an in-app window (QA asserts no external target appears).
Tray is behind `LITE_TRAY=1` (optional, unproven).

## Status / Phase 2 list

- All 13 QA checks green (RC=0): see `scripts/qa.mjs` + evidence.json under
  the QA_OUT dir (default `~/.hermes/cache/scratch/lite-electron-qa`).
- Messaging proven end-to-end with the injected `@hermes` session in room
  `Lite Electron QA` (send via UI composer echoed over sync; REST inbound
  message rendered live). Server-side transcripts confirmed; token/device
  untouched.
- Open for Phase 2: electron-builder config + installers/updater (mirror
  element-desktop), packaged protocol registration, tray, real IdP SSO run,
  Element Call join test against `call.plotina.cc`, E2EE device-verify UX,
  CSP header for the app server (dev Electron prints the insecure-CSP warning).
