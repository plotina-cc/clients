# Plotina Lite Desktop: Tauri → Electron migration plan

Status: draft for review · Owner: `desktop-shell` · Branch: `feat/lite-electron`
Companion: [`LITE_ELECTRON_REGRESSION.md`](LITE_ELECTRON_REGRESSION.md) · Risk analysis: companion branch `research/lite-electron-risks` (this plan's §9 is the authoritative release-risk list)

## 0. Summary

Plotina Lite Desktop is the Cinny web build wrapped in the upstream `cinny-desktop`
Tauri shell. Tauri uses the system WebKitGTK on Linux. Distribution WebKitGTK
builds do not enable `ENABLE_WEB_RTC`, so `RTCPeerConnection` is absent and calls
fail with "browser does not support WebRTC" on Arch and Ubuntu — the two Linux
targets we ship. Release `.17` enabled the WebKit media settings and added a
permission handler, but that cannot add a compile-time feature the distro build
does not contain.

The migration replaces **only the shell** with Electron. The Cinny web build,
the `noise/` overlay, branding, the homeserver config and the release tag series
stay unchanged. Electron ships its own Chromium, so WebRTC, screen capture and
media permissions behave the same on every supported Linux distribution and on
Windows.

This is a shell replacement, not a Cinny fork. The first Electron release is
`.18`; `.17` is the last Tauri build. Tauri `.17` has its updater disabled
(`cinny/tauri.plotina.json`: `createUpdaterArtifacts: false`, empty endpoints),
so the cross-grade is a manual download/install, followed by a required sign-in.
There is no automatic session or E2EE-key migration from WebKitGTK to Chromium;
the old profile is preserved and users restore encrypted history from key backup
(see §9, R1/R2).

## 1. Scope and non-goals

In scope:

- Electron main process, minimal preload, localhost static server, window/tray,
  protocols, external links, notifications, media permissions, single instance,
  window state, crash handling.
- `electron-builder` packaging for AppImage, deb, rpm, NSIS and MSI.
- The Plotina updater (GitHub Releases + `latest.yml` / `latest-linux.yml`) and
  the `/dl` stable-alias publishing path.
- CI, tests, release naming, cutover from the Tauri workflow, QA handoff.

Out of scope:

- Changes to Cinny's web source, `cinny/patches/`, `apply-noise.py`,
  `branding.py`, `noise/` (except the optional Settings update-button patch in
  Phase 3, which is additive).
- macOS builds. The current Tauri release does not ship macOS; Electron macOS is
  not a target for `.18`.
- Buying an Authenticode certificate. Signing is a decision gate, not a
  prerequisite (see §6.6).
- Migrating WebKitGTK IndexedDB/E2EE material into Chromium. Not technically
  sound; see §9 R1.

## 2. Baseline and target

| Area | Tauri `.17` (baseline) | Electron `.18` (target) |
|---|---|---|
| Runtime | System WebKitGTK 4.1 (Arch 2.54.2, Debian 12 older) | Bundled Chromium (Electron 44.4.5, the version proven by Plotina Desktop) |
| App origin | `http://localhost:44548`, served by `tauri-plugin-localhost` | `http://localhost:44548`, served by an internal Node HTTP server |
| Web content | `cinny/dist` compiled into the binary | Same `cinny/dist`, packed read-only into `web/` in the asar |
| Session storage | WebKitGTK local storage / IndexedDB | Chromium local storage / IndexedDB (different profile) |
| SSO | Tauri child webview with `window_features`; patched opener handling | Login-page SSO is tracked top-level navigation; UIA SSO is a native popup with real `window.opener` |
| Calls | WebKitGTK; broken on distro builds without `ENABLE_WEB_RTC` | Chromium; WebRTC, `getUserMedia`, `getDisplayMedia` |
| Tray | None | Tray with Show/Hide/Quit/Check for updates |
| Protocols | None | `plotina-lite:` and `matrix:` handlers |
| Updates | Disabled (`plugins.updater.endpoints: []`) | GitHub Releases feed; AppImage self-swap; NSIS silent install; deb/rpm via package manager |
| Packaging | Tauri bundles + custom NSIS | `electron-builder` 26.16.1 |
| Installer identity | `cc.plotina.chat` / product name `Plotina Lite Desktop` | Same appId and product name; new NSIS install dir and uninstall key |
| Build toolchain | Rust, WebKitGTK dev libs, Tauri CLI | Node 22/24 + `electron-builder`; no Rust, no WebKit |

### 2.1 Invariants

These must not change; QA treats a change as a regression:

1. Linux app origin is exactly `http://localhost:44548`. Changing host, port or
   scheme changes the storage origin and breaks the service worker.
2. Executable name is `plotina-lite`; `.desktop` `StartupWMClass` is
   `plotina-lite`; icons install as `plotina-lite.png` in hicolor.
3. Product name is `Plotina Lite Desktop`; appId is `cc.plotina.chat`.
4. The web bundle is the same dist the web client serves: `cinny/patches/`,
   `apply-noise.py`, `branding.py`, `noise/` and `cinny/config.json` are not
   modified for the shell migration.
5. Tag series continues `v4.12.8-plotina-lite-desktop.N`; no parallel tag
   namespace, no `-electron` suffix in the tag.
6. The default homeserver remains `plotina.cc`; SSO stays inside the app; no
   remote page receives Node/IPC access.

## 3. Phase overview

| Phase | Duration | Owner | Deliverable | Exit gate |
|---|---|---|---|---|
| 0 — Spike | 3 working days | `desktop-shell` + `qa-lead` | Throwaway Electron shell loads Cinny; SSO, WebRTC, screen share, messaging proven; spike report | Go/no-go signed by desktop, QA, product |
| 1 — Shell | 5 working days | `desktop-shell` | Production main process with all shell features and tests | Feature matrix 13/13; security checklist 10/10; unit tests green |
| 2 — Packaging | 4 working days | `packaging-ci` | AppImage/deb/rpm/NSIS/MSI, black icons, silent installers, cross-grade NSIS/deb | 5/5 formats build; silent installs 4/4; cross-grade 4/4; icon/WM checks |
| 3 — Updates | 3 working days | `desktop-shell` + `packaging-ci` | GitHub feed, `latest*.yml`, tray update UI, `/dl` aliases | U1–U7 pass; feed assets resolve; `.17`→`.18` manual path proven |
| 4 — Release/QA | 2 days + 1 QA day | `qa-lead` + `infra-edge` | `.18` draft release, regression run, morning report, old workflow retired | P0 100% pass; no open P0/P1 blockers; release published |

Dependencies: Phase 1 starts only after Phase 0 go. Phase 2 can start in parallel
with late Phase 1 once the shell entry point and icon set are frozen. Phase 3
needs Phase 2 artifacts. Phase 4 needs all three.

## 4. Phase 0 — Spike

**Question:** can an Electron shell load the existing Cinny dist, keep the
localhost service worker, complete both SSO flows, run a two-party call with
camera/screen share, and send/receive messages — without touching the web
bundle?

**Branch/worktree:** `spike/lite-electron`, worktree `../clients-lite-electron-spike`.
The spike is throwaway; it must not merge product code. It produces:
`docs/spikes/LITE_ELECTRON_PHASE0.md` plus raw evidence under
`/srv/qa/lite-electron/spike/`.

### 4.1 Work items

| ID | Task | Owner | Deliverable |
|---|---|---|---|
| P0.1 | Minimal Electron main: `BrowserWindow`, `show:false`, loads `http://localhost:44548`, static server over `cinny/dist` | `desktop-shell` | App opens login page on Arch X11 and Windows |
| P0.2 | Localhost server: bind loopback, MIME types, SPA fallback, Host check, no-cache `index.html`/`sw.js`, immutable hashed assets | `desktop-shell` | `navigator.serviceWorker.controller` non-null after reload |
| P0.3 | SSO: allow both flows — login-page SSO is a top-level navigation to the homeserver/IdP and back with `loginToken`; UIA SSO is a `window.open` popup with `postMessage('authDone')`. Verify opener, callback and close behavior. | `desktop-shell` | Both flows log in; UIA popup closes; no external-browser strand |
| P0.4 | WebRTC: `typeof RTCPeerConnection`, `getUserMedia({audio,video})`, two-party call with a web participant; record stats | `desktop-shell` + `qa-calls` | Audio and video both directions; no "WebRTC unsupported" |
| P0.5 | Screen share: `desktopCapturer` + `setDisplayMediaRequestHandler`; X11 and Wayland; portal picker or app picker | `desktop-shell` | Screen/window stream visible in call |
| P0.6 | Messaging: send/receive text, attachment upload/download (service-worker auth path), encrypted room, reload history | `qa-linux` | All pass on X11; evidence captured |
| P0.7 | Data-path discovery: run `.17`, locate WebKitGTK storage and WebView2 profile; document exact paths | `desktop-shell` | `docs/spikes/LITE_ELECTRON_DATA_PATHS.md` |
| P0.8 | Packaging smoke: one AppImage and one NSIS installer; launch and exit 0 | `packaging-ci` | Both launch on target OS |

### 4.2 Technical decisions to prove, not assume

- **Localhost vs custom scheme.** Use `http://localhost:44548`, not `app://`.
  Cinny registers `sw.js`, and that service worker rewrites Matrix media
  requests (`/_matrix/client/v1/media/download`, `.../thumbnail`) to add the
  `Authorization` header (`src/sw.ts`, `src/index.tsx` in Cinny). A custom scheme
  has no service-worker support, so thumbnails and authenticated downloads would
  break. The localhost origin also preserves the Tauri origin string, which is
  the only chance of any storage continuity.
- **Bind both loopback families.** Load `http://localhost:44548`, but bind the
  server to `127.0.0.1` and `::1` so Windows' `localhost` resolution cannot land
  on an unbound address. Reject any other `Host` header.
- **No COOP/COEP by default.** `Cross-Origin-Opener-Policy: same-origin` would
  sever `window.opener` for SSO popups. Do not add it to make wasm threads
  happy until ORT actually requires it; measure `crossOriginIsolated` and the
  noise stats first.
- **Electron popup, not a Tauri child webview.** `setWindowOpenHandler` with
  `action: "allow"` creates a real browser window with `window.opener`. Allow
  only Matrix auth URLs; all other URLs go to `shell.openExternal`.
- **Electron version.** Pin the version already proven by Plotina Desktop:
  Electron `44.4.5`, `electron-builder` `26.16.1` (see
  `element-desktop/desktop/icon.ts` and `element-desktop/desktop/updater.ts`).
  Do not float to `latest`.

### 4.3 Acceptance (all must pass)

| # | Check | Pass criterion |
|---|---|---|
| A1 | Load | Login page renders in ≤5 s on Arch X11; no `ERR_` in main log |
| A2 | Service worker | `navigator.serviceWorker.controller` non-null; `sw.js` 200 with JS MIME; an authenticated media thumbnail renders |
| A3 | SSO login page | "Continue with SSO" returns to app with `loginToken`; user is logged in |
| A4 | SSO UIA stage | Popup opens, IdP completes, `postMessage('authDone')` reaches opener; dialog advances |
| A5 | WebRTC | `RTCPeerConnection` function; `getUserMedia` resolves; two-party call has audio and video both ways for 5 min |
| A6 | Screen share | X11 screen/window share visible to the other participant; Wayland result recorded (pass or documented blocker) |
| A7 | Messaging | Text, attachment, encrypted room, history after reload all pass |
| A8 | Packaging | AppImage and NSIS launch; version printed; no immediate crash |
| A9 | Data paths | Exact Tauri/WebView2 profile paths documented with commands |

### 4.4 Go/no-go

Go if A1–A9 pass and no unresolved P0 blocker. No-go if the service worker cannot
run on localhost, both SSO flows cannot complete, or WebRTC fails in the bundled
Chromium. A Wayland-only screen-share failure is a **conditional go**: ship X11
screen share, keep Wayland as a P1 blocker for Phase 1 with a fix or explicit
release-note limitation. Data migration is explicitly not a gate (accepted risk).

## 5. Phase 1 — Shell features

**Branch:** `feat/lite-electron` (created from `main` after Phase 0 go).
**Owner:** `desktop-shell`; reviewer `security-review`; QA `qa-linux`.

### 5.1 Layout

```
cinny/electron/
  package.json                 electron 44.4.5, electron-builder 26.16.1
  tsconfig.json
  electron-builder.plotina.json
  src/main.ts                  app lifecycle, single instance, ready
  src/server.ts                localhost static server (port 44548)
  src/windows.ts               main window + SSO popup policy
  src/migration.ts             legacy Tauri profile detection + first-run notice
  src/window-state.ts          bounds persistence/clamping
  src/tray.ts                  tray + update menu entry
  src/protocols.ts             plotina-lite:/matrix: parsing and dispatch
  src/permissions.ts           media/notifications permission allowlist
  src/security.ts              navigation/window-open/webview hardening
  src/updater.ts               adapted from element-desktop/desktop/updater.ts
  src/logger.ts                userData/logs/main.log
  src/preload.ts               minimal contextBridge API (version, update IPC)
  build/icons/                 generated hicolor PNGs
  build/icon.ico               generated 16–256 ico
  build/installer.nsh          NSIS cross-grade cleanup
  tests/*.test.mjs             node:test unit tests
  web/                         staged cinny dist at build time (gitignored)
```

`cinny/scripts/build-electron.sh` reuses the existing clone/patch/web-build
steps from `cinny/scripts/build.sh`, then stages `cinny/electron/web`, compiles
TypeScript, and invokes `electron-builder` directly. The script must not use
`pnpm run`/`nx` wrappers around `electron-builder`: `${version}` macros get
re-quoted and expand to empty (the Element run #41 failure). Interpolate the
version in bash instead.

### 5.2 Feature matrix

| Feature | Implementation | Acceptance |
|---|---|---|
| Main window | `app.setName("Plotina Lite Desktop")` and an explicit `userData` path before ready (`appData/Plotina Lite Desktop`); `BrowserWindow` 1200×800, min 800×600, `show:false` until `ready-to-show`, title `Plotina Lite Desktop`, dark `backgroundColor`, icon capped at 128 px on Linux | Window opens centered, no white flash, title correct, `xprop WM_CLASS` contains `plotina-lite`, profile path is exactly `~/.config/Plotina Lite Desktop` / `%APPDATA%\Plotina Lite Desktop` |
| First-run migration | On launch, if a Tauri profile exists (`~/.local/share/cc.plotina.chat`, `%APPDATA%\cc.plotina.chat`) and Electron has no session, show a native dialog before login: sign-in is required, old data is kept, E2EE history needs Local Backup/key backup, buttons "Open old data folder" and "Continue"; persist `migrationNoticeShown` in Electron settings; never delete old data | Dialog appears once on `.17`→`.18` first launch; path opens in file manager; no data deleted; second launch does not repeat |
| Window state | JSON at `userData/window-state.json` `{x,y,width,height,maximized}`; save on `close`/debounced `resize`/`move`; restore only if it intersects a current display work area; on Wayland persist size/maximized only | Move/resize/maximize → quit → relaunch restores; disconnect second monitor → window stays on-screen |
| Tray | `Tray` with black/green 16/22/32 px icon chosen by `nativeTheme.shouldUseDarkColors`; menu Show, Hide, Check for updates…, About, Quit; click toggles; window close quits by default (parity with Tauri), `--hidden` starts hidden; creation failure logs and does not crash | Tray visible on KDE dark and light; Show/Hide/Quit work; close quits; no duplicate tray on second launch |
| Protocols | Register via electron-builder `protocols` (Linux `.desktop` `MimeType` + `xdg-mime`, Windows registry); on Linux do **not** call `setAsDefaultProtocolClient` from an AppImage (it would register the temporary mount path); call it on Windows only. Parse `plotina-lite://room/<id>` and `matrix:roomid/<id>` / `matrix:r/<alias>`; queue a pending link until login; single-instance forwards argv/URL | `xdg-open 'matrix:roomid/!…:plotina.cc'` focuses app and opens room after login on deb/rpm; Windows `start matrix:...` does the same; AppImage direct run documented as no auto-registration |
| External links | `setWindowOpenHandler`: allow only Matrix auth URLs in an SSO popup; `http(s)`/`mailto` → `shell.openExternal`; deny `file:`, `javascript:`, `data:`, unknown schemes. `will-navigate` blocks leaving the app except tracked SSO navigation | Link opens system browser once; app URL unchanged; auth popup still works; `file:///etc/passwd` does nothing |
| SSO | Login-page SSO is a tracked top-level navigation to the homeserver/IdP and back with `loginToken`; UIA SSO opens one tracked popup (520×720, min 320×480, parent main, no preload, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`). Reuse/focus the popup if already open; close 1.3 s after a callback URL with non-empty `loginToken` on `localhost`/`127.0.0.1`; no capabilities for remote pages. `will-navigate` allows the tracked SSO navigation only. | Both SSO flows pass; duplicate `window.open` does not create two popups; UIA popup closes after callback; remote page has `typeof require === "undefined"` |
| Notifications | Allow `notifications` permission for app origin; `app.setAppUserModelId("cc.plotina.chat")` on Windows; `app.setDesktopName("plotina-lite.desktop")` on Linux; notification click focuses/restores main window | Linux notification shows app name `Plotina Lite Desktop`; Windows toast shows app name; click focuses app; DND suppresses |
| Media permissions | `session.setPermissionRequestHandler`: allow `media`/`display-capture` only when `requestingUrl` is `http://localhost:44548` or `https://call.plotina.cc`; allow `notifications`; deny everything else. `setPermissionCheckHandler` mirrors it. `setDisplayMediaRequestHandler` with a small source picker | Mic/camera prompt appears in app and call iframe; remote SSO page cannot get devices; denying permission shows app error, not crash |
| Screen share | `desktopCapturer.getSources({types:["screen","window"]})`; app picker window lists sources with thumbnails; `callback({video: source, audio: "loopback"})`; Wayland uses PipeWire portal where required | X11: pick screen/window, other participant sees it; Wayland: portal/picker works or documented P1 limitation |
| Single instance | `app.requestSingleInstanceLock()` before ready; second instance exits 0; `second-instance` focuses/restores main and dispatches protocol URL | Launch twice → one process/window; second launch focuses first; protocol URL from second is handled |
| Crash/restart | `render-process-gone` logs reason and offers Reload/Quit; one automatic reload for `crashed`/`oom`; `child-process-gone` logged; `uncaughtException` writes log and shows dialog | `webContents.forcefullyCrashRenderer()` → dialog/reload, session survives; kill main → relaunch works; no corrupt window-state |
| Security | `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webviewTag:false`, `webSecurity:true`; no remote content; no preload on SSO window; local server Host allowlist + `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` | `typeof require/process` undefined in renderer; remote popup has no bridge; `curl -H 'Host: evil.test' http://127.0.0.1:44548/` returns 403 |

### 5.3 Details that tend to break

- **Port collision.** Port 44548 is fixed because the origin is part of the
  storage key and service-worker scope. If `EADDRINUSE`, show a native dialog
  naming the port and exit non-zero. Do not silently pick another port.
- **`localhost` vs `127.0.0.1`.** The URL must stay `http://localhost:44548`;
  binding must cover both loopback families. A mismatch produces `ERR_CONNECTION_REFUSED`
  on Windows IPv6-first resolution.
- **SSO opener.** Never set `nodeIntegration` or a preload on the SSO window.
  `window.opener` must remain live for `postMessage("authDone")`. Do not enable
  COOP on the app origin.
- **Service-worker media.** If thumbnails are broken, check the SW is
  controlling the page before blaming Matrix: `navigator.serviceWorker.controller`
  and a `/_matrix/client/v1/media/thumbnail/...` request with an `Authorization`
  header in DevTools.
- **Notification identity.** Without `app.setDesktopName("plotina-lite.desktop")`
  Linux notifications say "Electron"; without the Start Menu shortcut and AUMID,
  Windows toasts say "Electron" or do not appear.
- **Tray on Wayland.** Electron uses StatusNotifierItem; KDE supports it, GNOME
  needs an extension. Do not fail startup if tray creation fails.
- **Window icon.** Use the 128 px cap from `element-desktop/desktop/icon.ts`;
  a 256 px icon overflows the single `_NET_WM_ICON` request and leaves KDE with
  a generic icon.

### 5.4 Tests

- Unit (`node --test`): URL allowlist (`isMatrixAuthUrl`, `isLoginCallbackUrl`),
  protocol parser, window-state clamp, updater parser/version compare, Host
  header check.
- Integration (Playwright + CDP): first run, navigation blocking, permission
  denial, single instance, window state restore, tray menu (via main-process
  test hook), updater dialogs with a local feed.
- Manual: real SSO, real call, tray visibility, notifications.
- Test hooks (packaged builds; no UI): `--version` prints the app version and
  exits; `--plotina-theme=dark|light` sets `nativeTheme.themeSource`;
  `--remote-debugging-port=N`; `--user-data-dir=...`; `--qa-crash-renderer`
  for the crash/reload test. These are gated to packaged/QA use and do not
  change production behavior.

### 5.5 Exit criteria

- Feature matrix 13/13 implemented; no P0/P1 shell bug.
- `npm test`/`node --test` green; TypeScript `tsc --noEmit` clean.
- Security checklist 10/10: no Node in renderer, SSO window clean, permissions
  allowlisted, external links externalized, local server loopback-only/Host-checked,
  no `webview`, no remote module, no `--no-sandbox` in shipped builds,
  devtools disabled in production, CSP/frame headers present.
- Cold start to login ≤5 s and idle RSS ≤350 MB on Arch X11 (record baseline;
  exceeding by >30% is a review item, not automatically blocking).

## 6. Phase 2 — Packaging

**Owner:** `packaging-ci`; reviewer `infra-edge`; QA `qa-linux`, `qa-windows`.

Work split: `packaging-ci` owns the electron-builder config, build script, CI
jobs, NSIS `customInit`, MSI and the `.17`→`.18` cross-grade job; `desktop-shell`
owns icon generation, `.desktop`/WM_CLASS and the runtime identity; `security-review`
owns the signing decision; `infra-edge` owns the `/dl` asset mapping and install
script; QA owns the smoke runs.

### 6.1 Identity

| Setting | Value | Why |
|---|---|---|
| `appId` | `cc.plotina.chat` | Same as Tauri identifier; Windows AUMID and install identity |
| `productName` | `Plotina Lite Desktop` | Unchanged user-visible name |
| `executableName` | `plotina-lite` | `.desktop`, WM_CLASS, scripts, process name |
| Linux package name | `plotina-lite-desktop` | Same as `.17` deb/rpm, so package managers upgrade in place |
| deb/rpm version | `4.12.8-plotina.18` | Same scheme as `.17`; `dpkg` sees `.18` > `.17` |
| `.desktop` file | `plotina-lite.desktop` | Matches executable/icon; old `Plotina Lite Desktop.desktop` is removed on upgrade |
| `StartupWMClass` | `plotina-lite` | Matches Electron WM_CLASS; KDE task switcher |
| Icon theme name | `plotina-lite` | `hicolor/<size>/apps/plotina-lite.png` |
| Windows install dir | `%LOCALAPPDATA%\Programs\Plotina Lite Desktop` | electron-builder per-user default; old Tauri dir is cleaned by NSIS hook |
| NSIS shortcut names | `Plotina Lite Desktop.lnk` | Same visible name; upgrade replaces them |
| MSI product name | `Plotina Lite Desktop` | Clean-install path only (see §6.5) |

### 6.2 Targets and artifacts

| OS | Target | Versioned asset | Silent install | Notes |
|---|---|---|---|---|
| Linux | AppImage | `Plotina-Lite-Desktop-4.12.8-plotina.18.AppImage` | n/a | Self-updating via AppImage swap; FUSE2 or `--appimage-extract-and-run` |
| Linux | deb | `Plotina-Lite-Desktop-4.12.8-plotina.18.deb` | `apt-get install -y ./…deb` | Package upgrade from `.17`; dependencies by apt |
| Linux | rpm | `Plotina-Lite-Desktop-4.12.8-plotina.18.rpm` | `dnf install -y ./…rpm` | Test on Fedora; package name/version continuity |
| Windows | NSIS | `Plotina-Lite-Desktop-4.12.8-plotina.18-setup.exe` | `setup.exe /S` | Primary cross-grade path; per-user; updater target |
| Windows | MSI | `Plotina-Lite-Desktop-4.12.8-plotina.18.msi` | `msiexec /i … /qn /norestart` | Clean install only; `.17` MSI must be uninstalled manually |

Also publish `.exe.blockmap` for NSIS and `latest.yml` / `latest-linux.yml`
(§7). Stable aliases are duplicated on the release and `/dl` (§7.5).

### 6.3 Icons (black Cinny brand)

Source of truth: `branding/icons/plotina-black.svg` and
`branding/icons/png/black-{32,48,64,128,192,256,512}.png`. Generate, do not
hand-edit:

- Linux hicolor: 16, 24, 32, 48, 64, 128, 256, 512, 1024 px RGBA PNG named
  `plotina-lite.png`; at least 8 sizes must land in deb/AppImage/rpm
  (the `.17` deb only had 32/128/256, which is a regression we fix).
- Electron `build/icon.png` 512 px; `build/icon.ico` 16/24/32/48/64/128/256 px.
- Tray: 16/22/32 px black on light panels, green variant on dark panels
  (`nativeTheme.shouldUseDarkColors`), so the mark stays visible.
- No upstream Cinny bird, no green app icon, no text-in-icon.

Generation command (pinned in `cinny/scripts/build-icons.sh`):

```bash
rsvg-convert -w "$s" -h "$s" branding/icons/plotina-black.svg -o "build/icons/${s}x${s}.png"
convert build/icons/16x16.png build/icons/24x24.png ... build/icon.ico
```

Acceptance: `identify` shows the expected dimensions and `RGBA`; `file` says PNG;
`_NET_WM_ICON` contains a 128×128 icon (not empty); launcher, window switcher,
taskbar and tray show the black mark; Windows shortcut/Alt-Tab show it.

### 6.4 Linux desktop integration

`cinny/electron/electron-builder.plotina.json` (shape):

```json
{
  "appId": "cc.plotina.chat",
  "productName": "Plotina Lite Desktop",
  "executableName": "plotina-lite",
  "directories": { "output": "dist", "buildResources": "build" },
  "files": ["dist/**/*", "web/**/*", "package.json"],
  "asar": true,
  "protocols": [
    { "name": "Matrix room link", "schemes": ["matrix", "plotina-lite"] }
  ],
  "linux": {
    "target": ["AppImage", "deb", "rpm"],
    "executableName": "plotina-lite",
    "icon": "build/icons",
    "category": "Network;InstantMessaging;Chat;",
    "desktop": {
      "entry": {
        "Name": "Plotina Lite Desktop",
        "Comment": "Matrix client for plotina.cc",
        "StartupWMClass": "plotina-lite",
        "MimeType": "x-scheme-handler/matrix;x-scheme-handler/plotina-lite;"
      }
    }
  },
  "deb": { "packageName": "plotina-lite-desktop" },
  "rpm": { "packageName": "plotina-lite-desktop" },
  "win": { "target": ["nsis", "msi"], "executableName": "plotina-lite", "icon": "build/icon.ico" },
  "nsis": {
    "oneClick": false,
    "perMachine": false,
    "allowToChangeInstallationDirectory": true,
    "deleteAppDataOnUninstall": false,
    "include": "build/installer.nsh",
    "artifactName": "Plotina-Lite-Desktop-4.12.8-plotina.18-setup.exe"
  },
  "msi": {
    "oneClick": false,
    "perMachine": false,
    "artifactName": "Plotina-Lite-Desktop-4.12.8-plotina.18.msi"
  },
  "publish": {
    "provider": "github",
    "owner": "plotina-cc",
    "repo": "clients",
    "releaseType": "release"
  }
}
```

The artifact names are interpolated in bash, not via `${version}` in a pnpm/nx
argument (see §5.1). CI asserts the packaged `resources/app-update.yml` has
`provider: github`, `owner: plotina-cc`, `repo: clients`, and no
`vector-im`/`element-web`/`cinnyapp` reference.

Post-build checks:

```bash
# deb
dpkg-deb -c dist/*.deb | grep -c 'icons/hicolor/[0-9]*x[0-9]*/apps/plotina-lite.png'  # >= 8
dpkg-deb -f dist/*.deb Package Version  # plotina-lite-desktop 4.12.8-plotina.18
# AppImage
./dist/*.AppImage --appimage-extract
grep -x 'StartupWMClass=plotina-lite' squashfs-root/*.desktop
find squashfs-root/usr/share/icons/hicolor -path '*/apps/plotina-lite.png' | wc -l  # >= 8
# rpm
rpm -qip dist/*.rpm | grep -E 'Name|Version|Release'
```

`desktop-file-validate` must return 0 for the packaged `.desktop`.

### 6.5 Windows installer identity and cross-grade

The `.17` Tauri NSIS uses:

- install dir `%LOCALAPPDATA%\Plotina Lite Desktop`;
- uninstall key `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Plotina Lite Desktop`;
- binary `plotina-lite.exe`;
- shortcuts `Plotina Lite Desktop.lnk`.

Electron-builder NSIS defaults to `%LOCALAPPDATA%\Programs\Plotina Lite Desktop`
and a GUID-based uninstall key. Without a cleanup hook, `.18` installs next to
`.17`, leaves the old directory and creates a second Apps & Features entry.

`build/installer.nsh` must run the old uninstaller silently before installing:

```nsh
!macro customInit
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Plotina Lite Desktop" "UninstallString"
  ${If} $0 != ""
    ; Tauri's uninstaller is NSIS and supports /S. Do not pass _?= here:
    ; it must remove its own directory and shortcuts.
    ExecWait '$0 /S'
  ${EndIf}
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Plotina Lite Desktop"
  DeleteRegKey HKCU "Software\Plotina"
!macroend
```

`deleteAppDataOnUninstall: false` is mandatory: old Tauri app data lives outside
the install dir, but a future uninstall must not delete the new Electron profile.
Verify with a Windows CI job:
1. install `.17` silently; create `%APPDATA%\cc.plotina.chat\qa-sentinel`;
2. install `.18` silently;
3. assert exactly one `Plotina*` uninstall entry, old install dir gone, sentinel
   still present, `%LOCALAPPDATA%\Programs\Plotina Lite Desktop\plotina-lite.exe`
   exists, version `4.12.8-plotina.18`;
4. launch `--version`, exit 0; uninstall `.18` silently; profile remains.

MSI: do not assume electron-builder's MSI `UpgradeCode` matches Tauri's WiX
`UpgradeCode`; treat `.18` MSI as a clean-install format until a `.17`→`.18` MSI
test proves otherwise. Release notes say "if you installed the .17 MSI,
uninstall it first". Revisit only if product requires MSI cross-grade.

Linux cross-grade:
- deb: same package name and higher version → `apt-get install ./…deb` upgrades;
  old desktop file is removed by dpkg; old profile in `~/.local/share/cc.plotina.chat`
  is untouched.
- rpm: same package name/version ordering → `dnf upgrade ./…rpm`; old profile
  untouched.
- AppImage: replace the file at `~/.local/bin/plotina-lite` (install script) or
  the user's chosen path; old profile untouched.

### 6.6 Signing

Current state: no Authenticode certificate; `.17` release notes already say
Windows SmartScreen will warn. `.18` keeps that state unless a certificate is
provided.

- CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false`; no `publisherName` in
  `app-update.yml`; `updater.ts` verifies **sha512 only** (TLS to GitHub plus
  the release metadata). This stops corruption, not a compromised repo/release.
- If a certificate is supplied (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`):
  electron-builder signs NSIS/MSI; `app-update.yml` gains `publisherName`; the
  updater must verify the downloaded installer with PowerShell
  `Get-AuthenticodeSignature` (`Status=Valid`, signer contains `Plotina`) before
  running it. Do not claim signed builds before `signtool verify /pa /v` passes
  in CI.
- Linux: publish `SHA256SUMS` for every asset. Optional GPG/minisign detached
  signatures (`.asc`) if a release key exists; the install script verifies only
  when the key is present. Do not block the release on this.
- Release notes must state signing status plainly; no "signed" wording without a
  verified signature.

### 6.7 CI workflow

New file `.github/workflows/build-cinny-electron.yml`, name
`Build Plotina Lite Desktop (Electron)`.

| Job | Runner | Output |
|---|---|---|
| `web` | ubuntu-24.04 | `plotina-lite-web-dist` artifact: built dist with noise + branding + source-map split; no Sentry upload (the web workflow owns the upload) |
| `linux` | ubuntu-24.04 | AppImage, deb, rpm, `latest-linux.yml`, staged stable aliases |
| `windows` | windows-latest | NSIS exe + blockmap, MSI, `latest.yml`, staged stable aliases |
| `linux-smoke` | ubuntu-24.04 | AppImage `--version` under Xvfb; deb/rpm metadata and icon checks |
| `windows-smoke` | windows-latest | silent install, registry/protocol, `--version`, uninstall |
| `windows-crossgrade` | windows-latest | `.17` → `.18` one-entry/sentinel proof |
| `release` | ubuntu-latest | draft GitHub release with all assets and `SHA256SUMS` |

Runner packages for Linux (Ubuntu 24.04 names): `libgtk-3-0t64`, `libnss3`,
`libasound2t64`, `libgbm1`, `libxss1`, `libxtst6`, `libatspi2.0-0t64`,
`libsecret-1-0`, `libnotify4`, `xdg-utils`, `rpm`, `fakeroot`, `xvfb`, `xdotool`,
`x11-utils`, `imagemagick`, `librsvg2-bin`, `desktop-file-utils`. No Rust, no
`libwebkit2gtk-4.1-dev`, no Tauri CLI.

Build once, package twice: the `web` job is the only place the Cinny dist is
built. Linux and Windows download the same `plotina-lite-web-dist.tar.gz`, so
the shell cannot ship a different web bundle per OS.

`windows` build must run `electron-builder` directly with `--publish never`; the
release job uploads assets. Do not let electron-builder publish on its own: a
failed Linux job must not leave a Windows-only release.

Set `concurrency: group: build-cinny-electron-${{ github.ref }}` with
`cancel-in-progress: false` for tag builds; a cancelled Linux job must not race a
Windows job into a partial draft.

### 6.8 Exit criteria

- 5/5 formats build from one tag; artifact names exactly as §7.1.
- Silent installs: NSIS `/S`, MSI `/qn`, deb/rpm non-interactive; all exit 0.
- Cross-grade: deb `.17`→`.18`, rpm `.17`→`.18`, AppImage replacement, NSIS
  `.17`→`.18` all pass; MSI documented as clean install.
- Icons: ≥8 hicolor sizes, black mark, `_NET_WM_ICON` non-empty, tray visible
  on dark/light.
- `.desktop` validates; WM_CLASS matches; notification app name correct.
- `app-update.yml` points at `plotina-cc/clients`; no upstream references.
- Checksums published; no unsigned-build claim.

## 7. Phase 3 — Updates

**Owner:** `desktop-shell` (updater code) + `packaging-ci` (metadata/assets);
reviewer `infra-edge`.

Work split: `desktop-shell` owns `updater.ts`, tray/menu entry and the local
feed harness; `packaging-ci` owns `latest*.yml` generation/assertions and asset
staging; `infra-edge` owns release promotion and `/dl`; QA owns U1–U7.

### 7.1 Naming contract (exact)

| Item | Value |
|---|---|
| First Electron tag | `v4.12.8-plotina-lite-desktop.18` |
| Later tags | `v4.12.8-plotina-lite-desktop.19`, `.20`, … |
| App version | `4.12.8-plotina.18` (tag prefix `v`, `-lite-desktop.` → `-plotina.`) |
| Workflow | `.github/workflows/build-cinny-electron.yml` |
| Workflow name | `Build Plotina Lite Desktop (Electron)` |
| Build artifacts | `plotina-lite-desktop-electron-linux`, `plotina-lite-desktop-electron-windows`, `plotina-lite-web-dist` |
| Linux assets | `Plotina-Lite-Desktop-4.12.8-plotina.18.AppImage`, `.deb`, `.rpm`, `latest-linux.yml` |
| Windows assets | `Plotina-Lite-Desktop-4.12.8-plotina.18-setup.exe`, `.exe.blockmap`, `Plotina-Lite-Desktop-4.12.8-plotina.18.msi`, `latest.yml` |
| Checksums | `SHA256SUMS` |
| Stable aliases | `Plotina-Lite-Desktop.AppImage`, `.deb`, `.rpm`, `Plotina-Lite-Desktop-setup.exe`, `Plotina-Lite-Desktop.msi` |
| Install script | `Plotina-Lite-Desktop-install.sh` (copy of `cinny/scripts/install-lite-appimage.sh`) |
| Release title | `Plotina Lite Desktop 4.12.8` |
| Old workflow | `.github/workflows/build-cinny-desktop.yml` (retired, see §8.2) |

Version derivation in CI and `scripts/build-electron.sh`:

```bash
if [[ "${GITHUB_REF_NAME:-}" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)-plotina-lite-desktop\.([0-9]+)$ ]]; then
  APP_VERSION="${BASH_REMATCH[1]}-plotina.${BASH_REMATCH[2]}"
else
  APP_VERSION="4.12.8-plotina.0-local"
fi
```

`electron-builder` receives `--config.extraMetadata.version="$APP_VERSION"`; the
packaged `app.getVersion()` and `latest*.yml` must both show it. Four-segment
versions (`4.12.8.18`) are forbidden: electron-builder mangles them in
`latest.yml` (the Element `.30` lesson).

### 7.2 Feed contract

- Windows metadata asset: `latest.yml`.
- Linux metadata asset: `latest-linux.yml`.
- Both are uploaded to every non-draft, non-prerelease GitHub release of
  `plotina-cc/clients` that carries them.
- `latest-linux.yml` must list the AppImage **before** the deb. The updater must
  select the `.AppImage` entry explicitly, not "first url" — a deb first would
  make the AppImage updater download a package it cannot install.
- The updater polls `https://api.github.com/repos/plotina-cc/clients/releases?per_page=100`,
  filters `draft: false` and `prerelease: false`, inspects at most the 5 newest
  releases with the metadata asset, compares numeric version tokens, downloads
  the named asset, verifies the top-level `sha512`, then installs.
- Poll: 30 s after launch, then every 6 h (GitHub unauthenticated API budget is
  60 req/h/IP). A manual check bypasses the timer.
- Feed URL comes from packaged `resources/app-update.yml`; `config.json`'s
  `update_base_url` is not the source of truth. CI asserts the packaged yml.

`updater.ts` is adapted from `element-desktop/desktop/updater.ts` (proven:
GitHub releases + `latest.yml` + sha512 + AppImage swap + NSIS `/S --updated`).
Changes for Lite:

1. `PLOTINA_RELEASES_FEED` stays `https://github.com/plotina-cc/clients/releases`.
2. Parse `latest-linux.yml` `files:` and choose the `.AppImage` entry; do not
   assume the first.
3. Update entry points: tray/app menu "Check for updates…" and optional
   Settings → About button (preload IPC). No Squirrel/autoUpdater.
4. Test-only feed override: when `PLOTINA_QA_UPDATES=1`, read
   `PLOTINA_UPDATE_FEED_URL` (a local HTTP server serving `latest*.yml` and
   artifacts). Production ignores both variables.
5. Windows optional signature verification via PowerShell
   `Get-AuthenticodeSignature` when `app-update.yml` has `publisherName`.

### 7.3 Behavior by install type

| Install | Update mode | UI | Acceptance |
|---|---|---|---|
| NSIS per-user | Download exe, sha512 verify, run `/S --updated`, quit | Check → available → download → "Restart to update"/"Later" | Version increments after restart; installer exit 0; no elevation |
| AppImage | Download next to running image, sha512 verify, atomic rename over `$APPIMAGE`, respawn | Same | Version increments; old inode still running until restart; read-only dir falls back to `~/Downloads` with path dialog |
| deb | Package manager owns files | Menu item says "Updates are managed by apt"; no download | `apt update && apt upgrade` upgrades; app shows guidance |
| rpm | Package manager owns files | Same, `dnf upgrade` guidance | `dnf upgrade` upgrades |
| MSI | No self-update | Menu item disabled with "reinstall from plotina.cc/dl" | Documented; no broken download |
| Portable/dev | No update | Hidden | `app.isPackaged` guard |

### 7.4 Cross-grade from `.17`

`.17` has no updater and no `latest*.yml`; it cannot auto-update to `.18`.
The cross-grade is manual and must be documented on the release page and `/dl`:

| Format | `.17` → `.18` | Data/session | Expected |
|---|---|---|---|
| deb | `sudo apt install ./Plotina-Lite-Desktop.deb` | Old WebKit profile untouched; not readable by Electron | Package version `.18`; re-login |
| rpm | `sudo dnf upgrade ./Plotina-Lite-Desktop.rpm` | Same | Package `.18`; re-login |
| AppImage | Replace `~/.local/bin/plotina-lite` (or run install script) | Same | New binary; re-login |
| NSIS | Run `.18` setup; hook removes `.17` | `%APPDATA%\cc.plotina.chat` untouched; not readable by Electron | One entry; re-login |
| MSI | Uninstall `.17` MSI manually, install `.18` MSI | Old profile untouched | Clean install; re-login |

No automatic downgrade path. If `.18` is withdrawn, `/dl` can point back to
`.17`, but a user who installed `.18` must reinstall `.17` manually; the
Electron updater never offers a lower version.

Profile locations to verify in P0.7 and preserve in every upgrade test:

- Tauri Linux app data: `~/.local/share/cc.plotina.chat` (WebKitGTK
  `localstorage.sqlite3`, `IndexedDB/`, cookies under the same tree; exact
  layout confirmed by P0.7).
- Tauri Windows app data: `%APPDATA%\cc.plotina.chat`; WebView2 profile:
  `%LOCALAPPDATA%\cc.plotina.chat\EBWebView` (verify; Wry may place it under the
  app data directory).
- Electron userData: `~/.config/Plotina Lite Desktop` on Linux,
  `%APPDATA%\Plotina Lite Desktop` on Windows.
- Do not delete any of these during install, upgrade, uninstall, or rollback.
  The only deletion is an explicit user action after a successful Electron
  sign-in.

### 7.5 `/dl` publishing

`scripts/publish-clients.sh` currently hardcodes Element-era asset names. Add a
Lite Electron branch (or a dedicated `scripts/publish-lite-electron.sh`) with:

```
Plotina-Lite-Desktop-${APP_VERSION}.AppImage  Plotina-Lite-Desktop.AppImage
Plotina-Lite-Desktop-${APP_VERSION}.deb       Plotina-Lite-Desktop.deb
Plotina-Lite-Desktop-${APP_VERSION}.rpm       Plotina-Lite-Desktop.rpm
Plotina-Lite-Desktop-${APP_VERSION}-setup.exe Plotina-Lite-Desktop-setup.exe
Plotina-Lite-Desktop-${APP_VERSION}.msi       Plotina-Lite-Desktop.msi
latest-linux.yml                               latest-linux.yml
latest.yml                                     latest.yml
```

Also copy `cinny/scripts/install-lite-appimage.sh` to
`/dl/Plotina-Lite-Desktop-install.sh`. The install script's expected desktop
file changes from `Plotina Lite Desktop.desktop` to `plotina-lite.desktop`;
update the constant and its Python test. Keep the stable download URLs
(`https://plotina.cc/dl/Plotina-Lite-Desktop.deb` / `.AppImage`) unchanged so
printed instructions keep working.

Publish verification:

```bash
for f in Plotina-Lite-Desktop.AppImage Plotina-Lite-Desktop.deb \
         Plotina-Lite-Desktop.rpm Plotina-Lite-Desktop-setup.exe \
         Plotina-Lite-Desktop.msi Plotina-Lite-Desktop-install.sh; do
  curl -fsSI "https://plotina.cc/dl/$f" | head -1
done
sha256sum Plotina-Lite-Desktop.AppImage  # equals release asset sha256
```

`latest*.yml` on `/dl` is informational; the updater reads GitHub. Do not point
the updater at `/dl` (no API pagination/metadata contract there).

### 7.6 Update tests

| ID | Test | Method | Pass |
|---|---|---|---|
| U1 | No update | Local feed with `version` = current; tray check | Dialog "up to date"; no download |
| U2 | Update available (AppImage) | Local feed `.19` + copy of AppImage, wrong-version current | Downloads, sha512 ok, swaps, restart shows `.19` |
| U3 | Update available (NSIS) | Local feed `.19` + setup exe | Downloads, runs `/S --updated`, restart shows `.19` |
| U4 | Bad sha512 | Local feed with corrupted artifact/sha | Refuses, deletes `.part`, current app intact, error shown |
| U5 | Deb guidance | deb install, tray check | Message names `apt`; no download |
| U6 | Feed asset names | Parse `latest-linux.yml` from CI | AppImage selected, not deb; version matches tag |
| U7 | Version ordering | Unit test `.19` > `.18`, `.17` not newer, 4-segment rejected | `isVersionNewer` correct |

### 7.7 Exit criteria

- `latest.yml`/`latest-linux.yml` are valid, attached and point at existing
  assets; CI check fails otherwise.
- U1–U7 pass; bad-sha test leaves the installed app untouched.
- Tray/menu update entry is discoverable; deb/rpm guidance correct.
- `/dl` stable aliases return 200 and match release checksums.
- `.17`→`.18` manual cross-grade proven for deb, rpm, AppImage, NSIS.
- Release notes explain no auto-update from `.17` and the re-login/key-backup
  requirement.

## 8. Phase 4 — Release and QA handoff

**Owner:** `qa-lead`; release captain `infra-edge`; sign-off `desktop-shell` +
product.

### 8.1 Exact release sequence

1. Merge the cutover PR to `main`: new Electron workflow, old Tauri workflow
   retired (§8.2), docs updated, install script/package names/version updated.
2. Confirm `main` is green; tag:
   ```bash
   git tag -a v4.12.8-plotina-lite-desktop.18 -m "Plotina Lite Desktop 4.12.8 (Electron)"
   git push origin v4.12.8-plotina-lite-desktop.18
   ```
3. CI builds `web` once, packages Linux/Windows, runs smoke/cross-grade, and
   creates a **draft** GitHub release titled `Plotina Lite Desktop 4.12.8`.
4. `qa-lead` downloads the draft assets once to
   `/srv/qa/lite-electron/v4.12.8-plotina-lite-desktop.18/`, verifies
   `SHA256SUMS`, and runs `LITE_ELECTRON_REGRESSION.md` (one day).
5. On GO: promote the draft (`gh release edit … --draft=false`), publish `/dl`
   aliases + install script, verify URLs/checksums.
6. Post-release: confirm the updater sees `.18` as current (no update), watch
   Sentry release `cinny@v4.12.8-plotina-lite-desktop.18`, GitHub downloads,
   issue triage for 72 h.
7. If NO-GO: keep the draft, fix on `feat/lite-electron`, and ship the fix as
   `.19` (or delete the tag only if the draft never left draft and the team
   agrees; never move a published tag), then rerun QA.

### 8.2 What to disable in the old Tauri workflow

`.github/workflows/build-cinny-desktop.yml` must be retired **before** the `.18`
tag is pushed. Exact changes:

| Current | Change |
|---|---|
| `on.push.tags: ["v*-plotina-lite-desktop.*"]` | Remove the `push` block entirely |
| `workflow_dispatch` | Keep, add boolean input `legacy_tauri` default `false` |
| `build` job | `if: github.event_name == 'workflow_dispatch' && github.event.inputs.legacy_tauri == 'true'` |
| `release` job | Delete; no tag releases from Tauri |
| `permissions: contents: write` | Change to `contents: read` |
| Artifact names `plotina-lite-desktop-linux/windows` | Rename `plotina-lite-desktop-tauri-linux/windows` |
| Workflow `name` | `Build Plotina Lite Desktop (Tauri, retired)` |
| Header comment | "LEGACY: superseded by build-cinny-electron.yml at .18; do not tag" |

Leave `.github/workflows/build-cinny-web.yml` unchanged: it still builds the web
client on `main` and on `v*-plotina-lite-desktop.*` tags; it does not upload
desktop assets and is the web deployment path. Accept the duplicate web build on
tag; the Electron workflow's `web` job is packaging input, not a deployment.

Also retire the Tauri-specific instructions in `cinny/README.md` (keep a short
"Tauri (retired at .17)" appendix), update `README.md` ("Cinny Desktop" build
commands), `SOURCE.md` (overlay still `cinny/`; shell is Electron now), and
`CREDITS.md` (Electron MIT, Chromium third-party notices). `cinny/tauri.plotina.json`
stays in tree for reproducibility of `.17`, but no workflow uses it.

### 8.3 Release notes requirements

Russian, same tone as `.17`, must include:

- "Переход на Electron: звонки работают на всех поддерживаемых дистрибутивах"
  (with the WebKitGTK reason in one sentence).
- **Sign-in required after upgrade**; old session cannot be transferred.
- **E2EE history**: export Local Backup / enable key backup **before**
  upgrading; restore after sign-in; without backup old encrypted history stays
  unreadable.
- Windows SmartScreen warning (unsigned installer); no "signed" claim.
- Linux formats and update behavior: AppImage self-updates; deb/rpm via package
  manager; `.17` cannot auto-update, download `.18` manually.
- Source link `https://github.com/plotina-cc/clients` and upstream tag.
- No upstream client name in the release title.

### 8.4 Rollback

- Keep `.17` release assets; do not delete them.
- If `.18` is broken before `/dl` publish: keep draft, fix, rebuild.
- If broken after publish: point `/dl` stable aliases back to `.17` and post a
  notice; `.18` users must reinstall `.17` manually (no downgrade in updater).
- If only the updater feed is broken: leave `.18` as latest manual download,
  publish `.19` with the fix; do not rewrite `latest*.yml` to a lower version.
- If Windows installer identity breaks: halt `/dl` `.exe`, publish manual
  uninstall instructions, fix NSIS hook, ship `.19`.
- Never move/delete a published tag; always a new patch release.

### 8.5 Exit criteria

- Regression matrix P0 100%, P1 ≥95% with no open P0/P1 blocker or signed waiver.
- Release assets/checksums/`latest*.yml` verified; `/dl` 200 and checksums match.
- Old Tauri workflow has no tag trigger and no release job; `.18` tag runs only
  Electron workflow.
- Docs updated; release notes published; morning report accepted.
- Post-release monitoring owner and 72 h window assigned.

## 9. Risks

Likelihood/impact: H/M/L. Owner is the role accountable for the mitigation.

| ID | Risk | L | I | Mitigation | Owner | Trigger/acceptance |
|---|---|---|---|---|---|---|
| R1 | **userData/localStorage migration.** Tauri Linux stores session/E2EE in WebKitGTK; Electron uses Chromium. No supported conversion. Windows WebView2→Electron is both Chromium but different profile/version; LevelDB copying is unsupported. | H | H | Do not auto-import. Preserve old profile; first-run migration notice; require re-login; pre-upgrade Local Backup/key-backup instructions; offer "Open old data folder", delete only on explicit action. Optional read-only UI-settings import behind a flag, never secrets. | `desktop-shell` | QA accepts re-login; old profile intact; encrypted history recoverable with backup |
| R2 | **Re-login/device churn.** New device ID, verification prompts, old device left signed in. | H | M | Release notes; QA device-list check; docs "sign out old device"; no forced logout of old device (can't without token). | `qa-lead` | Login works; old device listed; new device verified |
| R3 | **Cross-shell updater.** `.17` updater disabled; no `latest*.yml`; cannot auto-update to `.18`. | H | M | Manual `/dl` path; release notes; new updater only from `.18`; never advertise auto-update from `.17`. | `infra-edge` | `.17`→`.18` manual install proven on 4 formats |
| R4 | **Signature/trust.** Unsigned Windows installers; updater verifies sha512 only; repo compromise can ship a binary. SmartScreen warnings. | H | H | Publish `SHA256SUMS`; document; optional Authenticode + `Get-AuthenticodeSignature`; do not claim signed; future cert. | `security-review` | Release notes accurate; `app-update.yml` has no `publisherName` unless verified |
| R5 | **Windows installer identity.** Tauri and Electron NSIS use different install dir/uninstall key; duplicate entries, stale files, old shortcuts. MSI upgrade-code compatibility is unproven. | H | M | `customInit` runs old uninstaller; delete old keys; `deleteAppDataOnUninstall:false`; CI `.17`→`.18` proof. MSI clean install until proven. | `packaging-ci` | One entry; old dir gone; profile sentinel intact |
| R6 | **Service worker/custom scheme.** `app://` has no service worker; Cinny's SW adds Matrix auth to media; attachments/thumbnails break. | M | H | Keep `http://localhost:44548`; Phase 0 SW/media test; never switch to custom scheme without a web-side replacement. | `desktop-shell` | `navigator.serviceWorker.controller`; authenticated thumbnail renders |
| R7 | **Screen sharing/Wayland.** `desktopCapturer` needs PipeWire portal; picker UX differs; nested/headless Wayland may not expose sources. | M | H | `setDisplayMediaRequestHandler` + picker; test X11 and real KDE Wayland; require `xdg-desktop-portal`/`-kde`; document limitation if portal missing. | `desktop-shell` | X11 pass; Wayland pass or signed limitation |
| R8 | **Calls/WebRTC.** Bundled Chromium should fix, but TURN/firewall, iframe permissions, audio devices can still fail. | M | H | Two-party test on plotina.cc; `allow="microphone;camera;display-capture"`; TURN check; fake-device CI + real manual. | `qa-calls` | 5-min call, both directions, screen share |
| R9 | **SSO popup.** Electron `window.open`/opener edge cases; duplicate popups; remote page security. | M | H | `setWindowOpenHandler` allowlist; one tracked popup; no preload/Node; test both flows; close on callback. | `desktop-shell` | Both flows pass; remote has no `require` |
| R10 | **Fixed port 44548.** Another process or parallel QA instance occupies it; app blank/hang. | M | M | Detect `EADDRINUSE`, native dialog, exit 1; QA uses one instance per host/netns; never silently change port. | `desktop-shell` | Collision test shows clear error, no hang |
| R11 | **Linux sandbox/FUSE.** Electron AppImage needs unprivileged userns or setuid sandbox; Debian 12 may disable userns; FUSE2 may be absent. | M | M | Test Debian 12; document `--appimage-extract-and-run`; deb/rpm preferred; do not ship `--no-sandbox` by default. | `packaging-ci` | AppImage launches on Debian 12; no `--no-sandbox` in shipped config |
| R12 | **Packaging drift.** rpm tooling, electron-builder version, artifact names, `latest*.yml` ordering. | M | M | Pin Electron/electron-builder; CI checks; build once; explicit AppImage selection; artifact name interpolation in bash. | `packaging-ci` | All formats + metadata checks green |
| R13 | **Notification/tray identity.** "Electron" app name, missing toast, invisible black tray icon. | M | M | `app.setDesktopName`, AUMID + Start Menu shortcut, black/green tray variants, KDE dark/light test. | `desktop-shell` | Correct app name; toast/tray visible |
| R14 | **Protocol hijack.** Registering `matrix:` steals links from Element Desktop; uninstall leaves handlers. | L | M | Register `matrix:` knowingly; QA uninstall cleanup; document default-handler behavior; `plotina-lite:` always works. | `packaging-ci` | Uninstall removes handlers; `xdg-mime query default` sane |
| R15 | **Old Tauri workflow races release.** Both workflows trigger on the same tag; Tauri release job overwrites assets. | M | H | Retire Tauri workflow before `.18`; CI assert no Tauri run on tag. | `infra-edge` | `.18` tag runs only Electron workflow |
| R16 | **Performance/size.** Electron AppImage/RSS larger than Tauri; cold start slower. | H | L | Baseline and publish; no hard gate beyond §5.5; optimize later. | `desktop-shell` | Recorded; no user-visible hang |
| R17 | **Legal/source.** New Electron/Chromium licenses and source offer. | L | M | Include `LICENSES.chromium.html`; update `SOURCE.md`/`CREDITS.md`; release notes source link. | `infra-edge` | Source offer complete; licenses present |
| R18 | **Feed/version mistakes.** Four-segment version, stale `latest*.yml`, draft/prerelease filtering. | M | H | Bash version derivation; CI parse/version tests; publish non-draft; U1–U7. | `packaging-ci` | Update tests pass; `.18` current |

## 10. Decisions

| ID | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Replace the Tauri shell with Electron; keep the Cinny web bundle | Distro WebKitGTK lacks `ENABLE_WEB_RTC`; calls cannot be fixed in the shell | Accepted |
| D2 | First Electron tag `.18`; `.17` is the last Tauri build | Continuous user-facing version series; no parallel namespace | Accepted |
| D3 | Serve from `http://localhost:44548`, not a custom scheme | Preserves service-worker media auth and the only possible storage origin continuity | Accepted |
| D4 | No automatic session/E2EE migration; require re-login | WebKit↔Chromium storage is not convertible; silent partial import risks data loss | Accepted |
| D5 | NSIS is the Windows cross-grade path; MSI clean install until proven | electron-builder/Tauri MSI upgrade codes are not guaranteed to match; do not risk a half-upgrade | Accepted |
| D6 | Unsigned builds; sha512-only update verification until a certificate exists | No cert available; document honestly; add Authenticode when possible | Accepted |
| D7 | Fixed port 44548; fail loudly on collision | Origin is part of storage/SW identity; random port loses data | Accepted |
| D8 | Update entry point in tray/app menu; optional Settings button later | Avoid patching Cinny UI for shell functionality; tray is always available | Accepted |
| D9 | Retire Tauri workflow at cutover; keep source/config for `.17` reproducibility | Prevent dual releases and accidental Tauri tags | Accepted |

## 11. References

- `cinny/tauri.plotina.json` — Tauri build override; updater disabled.
- `cinny/desktop-patches/0002-plotina-sso-in-app-sign-in.patch` — Tauri SSO
  child-window workaround.
- `cinny/desktop-patches/0003-plotina-linux-webrtc-media.patch` — WebKit media
  settings/permission handler; cannot add compile-time `WEB_RTC`.
- `.github/workflows/build-cinny-desktop.yml` — current Tauri build/release.
- `.github/workflows/build-element-desktop.yml` — proven Electron/electron-builder
  CI pattern, including `latest*.yml` checks and Windows smoke.
- `element-desktop/desktop/updater.ts` — reusable GitHub/sha512/AppImage updater.
- `element-desktop/desktop/icon.ts` — 128 px `_NET_WM_ICON` cap.
- `element-desktop/build.plotina.json` — identity/publish shape.
- `cinny/scripts/install-lite-appimage.sh` — `/dl` install script and stable
  names.
- `scripts/publish-clients.sh` — `/dl` publishing (needs Lite Electron mapping).
- `branding/icons/` — black/green brand assets.
- Cinny `src/index.tsx`, `src/sw.ts` — service-worker registration and media
  auth rewrite.
- Cinny `src/app/components/uia-stages/SSOStage.tsx`,
  `src/app/pages/auth/login/Login.tsx` — both SSO flows.
- Cinny `src/app/plugins/call/CallEmbed.ts` — call iframe `allow` and widget URL.
