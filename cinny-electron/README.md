# Plotina Lite Desktop — Electron shell (Phase 1 + Phase 2 packaging)

Electron main/preload that loads the existing Cinny web build
(`cinny/scripts/build.sh` output), replacing the Tauri shell so calls work:
WebKitGTK distro builds lack WebRTC, Chromium has it. Phase 2 adds
electron-builder packaging (AppImage/deb/rpm + NSIS/MSI), black Cinny icon
identity, the Plotina updater (adapted `element-desktop/desktop/updater.ts`)
and the CI pipeline. Tauri cross-grade is explicitly out of scope: the old
installed base is negligible, so this ships clean installs and
Electron→Electron updates only.

## Layout

```
cinny-electron/
  package.json              # electron 44.4.5, electron-builder 26.16.1 (pinned)
  electron-builder.plotina.json  # packaging identity (appId cc.plotina.chat)
  build/                    # electron-builder buildResources:
    icons/{16..512}x*.png   #   hicolor set (generated from branding/icons/plotina-black.svg)
    icon.png icon.ico       #   app icon + Windows multi-size ico
    installer.nsh           #   NSIS customInstall: writes the install-kind marker
  src/main.js               # window, SSO, permissions, deep links, state
  src/preload.js            # contextBridge: metadata + updater IPC
  src/app-server.js         # static localhost server for the Cinny dist
  src/updater.js            # GitHub-releases feed updater (appimage/nsis self-update;
                            #   deb/rpm package-manager guidance; MSI manual-download)
  web/                      # STAGED Cinny dist at build time (gitignored, goes into asar)
  scripts/qa.mjs            # full acceptance harness (CDP, no deps; QA_BIN for packaged runs)
  scripts/debug-*.mjs       # targeted probes used while building this
  scripts/build-icons.sh    # icon generation + brand equivalence assert
  scripts/stage-web.sh      # validate + copy the dist into web/
  scripts/build-packages.sh # one-shot: version derive -> icons -> web -> builder -> asserts -> stable aliases
  scripts/fix-deb.sh        # restore hyphenated dpkg-sortable Version
  scripts/stage-release-assets.mjs  # stable aliases + SHA256SUMS (+latest*.yml fallback)
  scripts/install-lite-electron.sh  # silent curl|bash installer (deb/AppImage paths)
  scripts/qa-linux-package.sh       # packaged smoke: xprop identity + full qa.mjs
  scripts/test-updater.mjs  # updater unit tests (feed parsing, version ordering)
  assets/                   # icons copied from cinny/icons (black/graphite Cinny)
```

## Build packages

```bash
npm install                    # electron binary comes from ~/.cache/electron
LITE_DIST=/path/to/cinny/dist bash scripts/build-packages.sh linux    # AppImage deb rpm*
bash scripts/build-packages.sh windows                                 # NSIS + MSI (Windows host)
node scripts/test-updater.mjs                                          # updater unit tests
bash scripts/qa-updater-feed.sh                                        # U2/U4 against a local QA feed
SKIP_QA_HARNESS=1 bash scripts/qa-linux-package.sh appimage            # identity smoke
xvfb-run -a -s "-screen 0 1440x900x24" bash scripts/qa-linux-package.sh deb  # + messaging
python3 -m unittest discover -s ../cinny/tests -p 'test_install_lite_electron.py'  # silent installer
```
`* rpm needs rpmbuild on the build host (ubuntu CI installs `rpm`; Arch
without it warns and continues). Version: tag `v4.12.8-plotina-lite-desktop.N`
-> app version `4.12.8-plotina.N` (never four-segment); branch builds use
`4.12.8-plotina.0.local`. Never `${version}` macros through pnpm/nx wrappers.
Artifacts: `Plotina-Lite-Desktop-<version>-<arch>.{AppImage,deb,rpm,exe,msi}`
plus `latest.yml`/`latest-linux.yml`, `.exe.blockmap`, and stable aliases +
`SHA256SUMS` in `dist/stable/` for `/dl`. CI: workflow
`build-cinny-electron.yml` (workflow_dispatch only until the Phase-4 release
switch — see the header comment for the exact activation diff).

## Run (dev)

```bash
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

**Deep links (`cc.plotina.chat://`).** Packaged registration comes from
electron-builder `protocols` (deb/rpm `.desktop` `MimeType=x-scheme-handler/…`,
Windows registry via NSIS/MSI); `setAsDefaultProtocolClient` is called only in
dev and on Windows — from an AppImage it would register the temporary mount
path. Linux second-instance argv forwarding rewrites/mangles the command line —
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
prevented), black/graphite Cinny icon (`assets/icon.png`, delivered to
`BrowserWindow` capped at 128 px via `nativeImage` on Linux — a 256+ px
`_NET_WM_ICON` payload exceeds the X protocol request limit and leaves the
property empty, the element-desktop `icon.ts` lesson), bounds + maximized
persisted to `<userData>/window-state.json` (save on close/resize/move
events; scripted `resizeTo` fires `resize` but not `resized`, and
`window.close()` skips `close` — bound accordingly; save/restore verified in
`debug-windowstate.mjs`). Single-instance lock with focus-on relaunch.
External links: non-app `will-navigate`/`window.open` → `shell.openExternal`,
never an in-app window (QA asserts no external target appears).
Tray is behind `LITE_TRAY=1` (optional; menu carries "Check for updates…").

**Packaged web dist.** `web/` (staged by `scripts/stage-web.sh`, validated for
`index.html`/`sw.js`/`config.json` + the `plotina:sso:login-token` marker)
goes into the app asar; `app-server.js` reads it through Electron's patched
`fs`, so the same localhost server serves the bundled dist. `LITE_DIST` still
overrides for dev/QA. WM_CLASS measured on the packaged binary is
`plotina-lite-desktop`, and the `.desktop` `StartupWMClass`/`Icon` match it
(xprop-asserted by `scripts/qa-linux-package.sh`).

**Updater.** `src/updater.js` (adapted from `element-desktop/desktop/updater.ts`):
reads `resources/app-update.yml` (electron-builder writes
`provider: github, owner: plotina-cc, repo: clients`), lists GitHub releases,
fetches `latest.yml` / `latest-linux.yml`, verifies sha512, then acts by
install kind: AppImage atomic rename-swap + restart; NSIS silent
`/S --updated`; deb/rpm package-manager guidance; **MSI manual-download
state** — the NSIS `customInstall` writes an `install-kind` marker next to the
exe, a packaged Windows install without it is MSI and only ever offers
"Open download page". Unsigned builds, TLS + sha512 only (same trade-off as
Plotina Desktop). `PLOTINA_QA_UPDATES=1` + `PLOTINA_UPDATE_FEED_URL` point the
feed at a local server for U1–U7; `LITE_NO_UPDATES=1` disables polling.

## Status / open items

- Phase 2 verified on this host (Arch): AppImage + deb built from the bundled
  dist; deb assertions (8 hicolor icons, hyphen-sortable Version, `.desktop`
  validated, WM_CLASS/StartupWMClass/`_NET_WM_ICON 128x128` via xprop);
  updater unit tests green; full qa.mjs against the PACKAGED binary.
- rpm builds where `rpmbuild` exists (ubuntu CI installs `rpm`); the NSIS
  auto-updating installer cross-builds from Linux via
  `bash scripts/build-packages.sh win-nsis` (proven here: exe + blockmap +
  latest.yml); MSI needs the Windows job (WiX via wine here needs Wine-Mono,
  absent).
- Open for Phase 3/4: tray dark/light variants, real IdP SSO run, Element
  Call join test against `call.plotina.cc`, E2EE device-verify UX, CSP header
  for the app server, `/dl` promotion + draft-release job, U1–U7 on a real
  feed, Settings → About update button (preload IPC already exists).
