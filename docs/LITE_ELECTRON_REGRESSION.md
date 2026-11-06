# Plotina Lite Desktop: Electron regression matrix

Status: draft for execution after the `.18` build · Owner: `qa-lead`
Companion: [`LITE_ELECTRON_MIGRATION.md`](LITE_ELECTRON_MIGRATION.md)

This is the executable matrix for the Tauri → Electron migration. It is written
to be split across agents: each section names the environment, the exact steps,
the evidence to capture, and the pass/fail line. Run it against the **draft**
release assets, before `/dl` is switched and before the release is published.

## 1. Environments

| ID | Environment | How to provision | Prerequisites | Known limits |
|---|---|---|---|---|
| E1 | Arch/CachyOS, KDE, **X11** | `Xvfb :130 -screen 0 1400x900x24 &` + `DISPLAY=:130 openbox &`; `DISPLAY=:130`; `XDG_RUNTIME_DIR=/tmp/qa-e1`; `dbus-run-session` wrapper | `xdotool`, `xprop`, `imagemagick`, `ffmpeg`, `openbox`, `desktop-file-utils`, PipeWire/PulseAudio | Xvfb has no KDE panel; tray/window-switcher visuals need E2 or a real KDE session |
| E2 | Arch/CachyOS, KDE, **Wayland** | `dbus-run-session -- kwin_wayland --virtual --xwayland --socket wayland-qa --width 1400 --height 900`; `WAYLAND_DISPLAY=wayland-qa`; `XDG_RUNTIME_DIR=/tmp/qa-e2` | `xdg-desktop-portal`, `xdg-desktop-portal-kde`, `pipewire`, `wireplumber`, `spectacle`, `wayland-info` | Nested KWin may not expose screencast sources; physical KDE Wayland session required for final screen-share sign-off |
| E3 | **Debian 12** (bookworm) | Build once: `docker build -t qa/debian12-electron qa/debian12/`; run `--network none` for clean-install tests, `--network host` only for updater tests; Xvfb `:99` inside container | `libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libatspi2.0-0 libsecret-1-0 libnotify4 xdg-utils xvfb openbox xdotool x11-utils` | Electron sandbox may need `--no-sandbox` **for packaging smoke only**; security checks run on E1 |
| E3b | Fedora 41 (optional, rpm) | `docker run --rm -it fedora:41`; install `rpm`, `gtk3`, `nss`, `alsa-lib`, `mesa-libgbm`, `libXScrnSaver`, `libXtst`, `at-spi2-atk`, `libsecret`, `libnotify`, `xdg-utils`, `xvfb` | same as E3 | rpm install/upgrade only; no visual sign-off |
| E4 | **Windows CI** | GitHub Actions `windows-latest`; jobs from `.github/workflows/build-cinny-electron.yml` | PowerShell 7, `gh`, `.17` and `.18` installers | No audio/camera; notifications/tray visuals may be unavailable; fake media only |
| E4m | Windows 11 manual | QA VM/desktop with audio, camera, notifications enabled; snapshot before install | Same installers, SmartScreen interaction, two accounts | Manual; schedule with `qa-windows`; do not claim pass without screenshot/video |
| E5 | **Web `lite.plotina.cc`** | Chromium via Playwright on host; existing `e2e/` setup can host a small spec | `e2e/node_modules`, test account B | No desktop port; must stay unchanged; authenticated checks depend on account B |

### 1.1 Shared artifacts (download once)

`qa-lead` stages the release once; every agent verifies and copies from the
mirror, never re-downloads 130 MB per agent:

```bash
TAG=v4.12.8-plotina-lite-desktop.18
DEST=/srv/qa/lite-electron/$TAG
gh release download "$TAG" -R plotina-cc/clients -D "$DEST" --clobber
( cd "$DEST" && sha256sum * > SHA256SUMS )
```

Also stage the last Tauri build once:

```bash
gh release download v4.12.8-plotina-lite-desktop.17 -R plotina-cc/clients \
  -D /srv/qa/lite-electron/v4.12.8-plotina-lite-desktop.17
```

Each agent works from its own copy, e.g. `/tmp/qa-e1/assets`, and runs
`sha256sum -c SHA256SUMS` before starting. Evidence goes to
`/srv/qa/lite-electron/$TAG/evidence/<env>/<scenario>/`.

Test data (never commit credentials; use the vault):

- Account A: desktop sessions; account B: web participant / second device.
- Rooms: `#qa-lite-regression:plotina.cc` (normal), `#qa-lite-encrypted:plotina.cc`
  (encrypted), plus a DM between A and B.
- Fixtures: `qa/fixtures/thumb.png` (small PNG), `qa/fixtures/doc.pdf`,
  `qa/fixtures/big.bin` (20 MB) for attachment/checksum tests.
- For calls where account B is unavailable, use a second desktop on E4m/E1 with
  the same two-account rule; never join twice with the same device.

### 1.2 Parallelism constraints (read before scheduling)

- **Port 44548 is fixed** and is part of the app's storage/service-worker
  identity. Two Electron instances on the same network namespace cannot run at
  the same time. E1 and E2 on the same host are therefore **sequential**, unless
  each track runs in its own network namespace (`unshare -Urn` with loopback) or
  container.
- E3 runs in Docker with `--network none`, so it can run in parallel with E1.
- E4 runs on a separate Windows runner/VM, so it can run in parallel.
- E5 uses only a browser; no app port, so it can run in parallel.
- Test accounts: use account A for the desktop and account B for the web
  participant. Do not run two auth/session tests with account A concurrently;
  device-list and verification assertions will race.
- Updater tests mutate the install and feed; use a disposable AppImage copy or a
  VM snapshot. Uninstall tests destroy the install; run them last on a
  disposable environment.
- Unique displays/CDP: E1 `:130`/`9401`, E2 `:131`/`9402`, E3 `:99`/`9403`
  (inside container), E5 browser CDP `9404`, calls `:133`/`9405`+`9406`,
  updater `:132`/`9407`. Never reuse a display or CDP port across agents.

## 2. Priority and automation legend

| Mark | Meaning |
|---|---|
| P0 | Release blocker. Any failure stops the `.18` release. |
| P1 | Must pass before sign-off; a waiver requires `qa-lead` + `desktop-shell` sign-off. |
| P2 | Record and fix later; does not block `.18`. |
| A | Fully automated: CLI, Playwright/CDP, PowerShell, package tools. |
| S | Semi-automated: script + screenshot/`xprop`/`xdotool`, human reads the result. |
| M | Manual: real SSO, real devices, visual/tray/notification judgement. |
| ☐ | Result column to fill: `P` pass, `F` fail, `S` skip with reason. |

Severity mapping: P0 = S1, P1 = S2, P2 = S3/S4. A P0 skip is a NO-GO unless the
environment is unavailable and the scenario is repeated on an equivalent
environment.

## 3. Matrix

### 3.1 Install, upgrade, uninstall

| ID | P | Scenario and steps | Expected / pass criterion | Auto | Evidence |
|---|---|---|---|---|---|
| I-01 | P0 | **Clean AppImage, E1.** Download `Plotina-Lite-Desktop.AppImage`, `chmod +x`, run with a fresh profile. | Exit 0; login page ≤5 s; process alive 30 s; `--version` prints `4.12.8-plotina.18`; no `ERR_`/unhandled dialog. | A | `app.log`, `version.txt`, `screen.png` |
| I-02 | P0 | **Clean deb, E3.** `apt-get install -y ./Plotina-Lite-Desktop-4.12.8-plotina.18.deb`; launch `plotina-lite`. | Package `plotina-lite-desktop` version `4.12.8-plotina.18`; `/usr/bin/plotina-lite`; `plotina-lite.desktop`; login page. | A | `dpkg -l`, `dpkg -L`, `screen.png` |
| I-03 | P1 | **Clean rpm, E3b.** `dnf install -y ./Plotina-Lite-Desktop-4.12.8-plotina.18.rpm`; launch. | Package name/version correct; binary/desktop/icon present; login page. | A | `rpm -qi`, `rpm -ql`, `screen.png` |
| I-04 | P0 | **Clean NSIS, E4.** `Start-Process ...-setup.exe -ArgumentList '/S' -Wait`; inspect install; launch `--version`. | Exit 0; `%LOCALAPPDATA%\Programs\Plotina Lite Desktop\plotina-lite.exe`; one uninstall entry; `--version` prints `.18`; protocol keys exist. | A | `install.log`, registry export, `version.txt` |
| I-05 | P1 | **Clean MSI, E4.** `msiexec /i ...msi /qn /norestart`; launch; uninstall. | Exit 0; app installed/launchable; uninstall removes files/shortcuts; profile untouched. | A | `msiexec.log`, `Get-Package`, `screen.png` |
| I-06 | P0 | **Tauri `.17` → `.18` deb, E3.** Install `.17` deb; create `~/.local/share/cc.plotina.chat/qa-sentinel`; install `.18` deb; launch. | `dpkg -l` shows `.18`; old `Plotina Lite Desktop.desktop` gone; `plotina-lite.desktop` present; sentinel intact; app opens at login (no session). | A | `dpkg` before/after, `find` sentinel, `screen.png` |
| I-07 | P0 | **Tauri `.17` → `.18` AppImage, E1.** Install `.17` AppImage to `~/.local/bin/plotina-lite`; create sentinel; replace with `.18`; launch. | New binary runs; version `.18`; old profile intact; login screen; no stale tray/icon. | S | `sha256sum`, `find`, `screen.png` |
| I-08 | P0 | **Tauri `.17` → `.18` NSIS, E4.** Silent-install `.17`; create `%APPDATA%\cc.plotina.chat\qa-sentinel`; silent-install `.18`; inspect entries/dirs; launch. | Exactly one `Plotina*` uninstall entry; old `%LOCALAPPDATA%\Plotina Lite Desktop` gone; sentinel intact; new exe `.18`; app opens at login. | A | registry export, dir listing, `screen.png` |
| I-09 | P1 | **Tauri `.17` → `.18` rpm, E3b.** Install `.17` rpm; sentinel; `dnf upgrade` `.18`; launch. | `rpm -q` `.18`; sentinel intact; login screen. | A | `rpm -q`, sentinel |
| I-10 | P1 | **Uninstall/reinstall deb, E3.** Uninstall `.18`; inspect; reinstall; launch. | Binary/desktop/icons/handlers removed by uninstall; profile `~/.config/Plotina Lite Desktop` **not** removed; reinstall keeps session if profile survived. | A | `dpkg -l`, `find ~/.config`, `screen.png` |
| I-11 | P1 | **Uninstall/reinstall NSIS, E4.** Uninstall silent; inspect; reinstall; launch. | Files/shortcuts/uninstall entry/protocol keys removed; `%APPDATA%\Plotina Lite Desktop` remains; reinstall keeps session. | A | registry, `Get-ChildItem`, `screen.png` |
| I-12 | P2 | **MSI `.17` cross-grade, E4m.** Install `.17` MSI, then `.18` MSI without uninstalling. | Documented result: either clean upgrade or explicit "uninstall .17 first" message; no half-installed state. | M | notes, `Get-Package` |

### 3.2 First run, SSO, logout, re-login, data persistence

| ID | P | Scenario and steps | Expected / pass criterion | Auto | Evidence |
|---|---|---|---|---|---|
| A-01 | P0 | **First run, E1/E4.** Fresh profile, launch; inspect login page, homeserver field, theme, window. | `plotina.cc` default; custom homeserver disabled; theme follows OS (dark OS → dark); 1200×800 default; no console errors. | S | `screen.png`, `app.log`, CDP console |
| A-02 | P0 | **SSO login-page flow, E1/E4m.** Click "Continue with SSO"; complete IdP; return. | Whether the app navigates the main window or opens a popup, the homeserver/IdP round trip is allowed; app receives `loginToken`; logged in; no system-browser dead end; any popup closes ≤3 s. | M | video/screens, `app.log`, network log |
| A-03 | P0 | **SSO UIA stage, E1/E4m.** Trigger a UIA SSO stage (add device/verification); complete popup; wait for `authDone`. | Popup `window.opener` live; `postMessage('authDone')` advances dialog; stage completes; no duplicate popup. | M | video, console log, screenshot |
| A-04 | P0 | **Logout.** Settings/Sessions → Logout; inspect storage; restart. | Returns to login; `cinny_access_token`/`cinny_user_id`/`cinny_device_id`/`cinny_hs_base_url` absent; restart stays logged out; no crash. | A | CDP localStorage dump, `screen.png` |
| A-05 | P0 | **Re-login.** Log in again; restart app; inspect device list. | Session persists across restart; room list loads; device list shows the new Electron device; old Tauri device still listed. | A/S | `screen.png`, device-list screenshot |
| A-06 | P0 | **Session persistence same shell.** Send a message, restart, reopen room. | Still logged in; message visible; no re-auth; window state restored. | A | screenshot, log |
| A-07 | P0 | **Cross-shell data/re-login.** On `.17`, sign in, join encrypted room, export Local Backup; upgrade to `.18`; launch; sign in; restore backup; open room. | `.18` starts at login (expected); old Tauri profile exists untouched; re-login works; backup restores; old encrypted history decrypts. | M | before/after screenshots, backup file, profile listing |
| A-08 | P0 | **First-run migration notice.** Install `.18` over `.17` (with old profile present), launch; inspect dialog; click "Open old data folder"; restart. | Dialog explains re-login/old data/E2EE backup; "Open old data folder" opens the old profile; "Continue" goes to login; old data not deleted; notice shown once. | S | dialog screenshots, `find` old/new profiles |

### 3.3 Messaging and rooms

| ID | P | Scenario and steps | Expected / pass criterion | Auto | Evidence |
|---|---|---|---|---|---|
| M-01 | P0 | **Send/receive.** A sends text in DM and room; B (web) replies; repeat 10 messages. | Both sides receive ≤2 s; ordering correct; no duplicate/lost messages. | A | Playwright transcript, screenshots |
| M-02 | P0 | **History.** Restart A; scroll back; check edits, replies, redactions. | History loads; edits/replies/redactions render correctly; no blank timeline. | A | screenshots, log |
| M-03 | P0 | **Attachments.** Upload PNG (thumbnail), PDF (download), 20 MB file; check encrypted room. | Upload progress; thumbnail via service worker; download checksum matches; encrypted attachment decrypts; no 401/403. | A | `sha256sum`, network log, screenshots |
| M-04 | P1 | **Room switching.** Switch across 10 rooms/spaces/DMs; check unread badges. | No blank screen >1 s; unread counts correct; active room highlight; no crash. | A | screen recording, log |
| M-05 | P1 | **Notifications.** Background the app; B sends a message; click notification. | Notification appears ≤2 s with app name/icon; click focuses app and opens room; DND suppresses; no duplicate notifications. | S/M | `dbus-monitor`, screenshot, video |

### 3.4 Calls (two participants)

Use account A on the desktop and account B on `lite.plotina.cc` (Chromium) unless
a second desktop is available. For automated runs launch A with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`; repeat the
P0 call manually with real mic/camera on E1/E4m.

| ID | P | Scenario and steps | Expected / pass criterion | Auto | Evidence |
|---|---|---|---|---|---|
| C-01 | P0 | **Audio join.** A joins room call; B joins; speak both ways 5 min; mute/unmute. | Both hear each other; mute stops audio; unmute restores; call stays connected; no "WebRTC unsupported". | A/M | 30 s video, `getStats()` JSON |
| C-02 | P0 | **Camera.** Enable camera on both; toggle off/on. | Both see video; toggle stops/starts track; no frozen frame; frames decoded increases. | A/M | screenshots, `getStats()` |
| C-03 | P0 | **Screen share X11.** A shares entire screen, then a window; B confirms; stop share. | B sees shared content; picker lists sources; stop returns to camera/avatar; no crash. | S/M | 30 s video, screenshots |
| C-04 | P1 | **Screen share Wayland.** Repeat C-03 on E2/physical KDE Wayland with portal. | Portal/picker appears; B sees content; if portal unavailable, documented P1 limitation with log. | M | video, `journalctl` portal log |
| C-05 | P0 | **Join/leave/rejoin.** B leaves; A sees participant leave; B rejoins; A leaves; call ends. | Participant list updates; media stops; rejoin works; no ghost participant; call UI returns to room. | A/M | video, screenshots |
| C-06 | P1 | **Noise suppression.** In call, open noise dropdown; change level; inspect `window.__plotinaNoiseStats` in iframe. | `isSupported()` true; `processed` increases; audio audible; toggle off restores raw mic; no console error. | S/M | stats JSON, screenshot |
| C-07 | P1 | **Encrypted room call.** Start call in encrypted room; join from B. | Call connects; no key errors; messages/call UI work. | M | video, log |
| C-08 | P2 | **Network/TURN.** Check `getStats()` selected candidate pair; repeat on a restrictive network if available. | Selected pair exists; relay candidate when needed; call connects within 15 s. | S | stats JSON |

### 3.5 Desktop integration

| ID | P | Scenario and steps | Expected / pass criterion | Auto | Evidence |
|---|---|---|---|---|---|
| D-01 | P0 | **External links.** Click http(s), `mailto:`, `matrix.to` room link, and a `file://` link in a message. | http(s)/mailto open system browser/client once; `matrix.to` opens app room; `file://` does nothing; app URL unchanged. | S | browser log, screenshots |
| D-02 | P1 | **Protocols.** `xdg-open 'plotina-lite://room/<id>'`; `xdg-open 'matrix:roomid/<id>'` warm and cold; logged-out case. | App focuses/opens room when logged in; logged-out queues link and resumes after login or lands on login with link stored; no crash. | S | `xdg-mime query`, screenshots |
| D-03 | P0 | **Themes.** On Xvfb use `--plotina-theme=dark` or `--plotina-theme=light`; on E2/E4m toggle the OS theme; restart; set manual Light/Dark in Settings. | App follows OS on "system"; manual choice persists; login page and app both correct; no white flash. | S | screenshots dark/light |
| D-04 | P1 | **Noise dropdown readability.** Settings → General → Sound; screenshot select closed/open in dark and light. | Text and options readable; contrast ≥4.5:1 for normal text; no white-on-white/black-on-black. | S | screenshots, computed styles |
| D-05 | P0 | **Launcher icons.** Inspect `/usr/share/icons/hicolor/*/apps/plotina-lite.png`; open app menu; check icon. | ≥8 sizes; black Cinny mark; no green app icon; no upstream bird; menu shows correct icon. | S | `identify`, `find`, screenshot |
| D-06 | P0 | **Window switcher/WM_CLASS.** `xdotool search --name 'Plotina Lite Desktop'`; `xprop WM_CLASS _NET_WM_ICON`; visual check on E2. | `WM_CLASS` contains `plotina-lite`; `_NET_WM_ICON` has 128×128 data, not empty; KDE switcher shows mark (E2). | S | `xprop.txt`, E2 screenshot |
| D-07 | P1 | **Tray.** Check tray on dark/light panel; Show/Hide; close window; Quit menu; second launch; update item. | Tray visible; Show/Hide/Quit work; close quits by default; no duplicate tray; update item present/disabled correctly. | S | screenshots |
| D-08 | P1 | **Window state.** Move/resize/maximize; quit; relaunch; disconnect second monitor; relaunch. | Bounds/maximized restored; window stays visible on remaining display; Wayland persists size only. | S | `xprop`, screenshots |
| D-09 | P1 | **Notification identity.** Trigger notification; inspect notification UI; click. | App name `Plotina Lite Desktop`; icon correct; click focuses app/room. | S/M | screenshot, `dbus-monitor` |
| D-10 | P0 | **Media permission prompts.** First call: allow mic/camera; restart: permission remembered; deny case; remote SSO popup calls `getUserMedia`. | Prompt appears only for app/call origin; allow works; deny shows error not crash; SSO origin denied. | M | screenshots, console |
| D-11 | P0 | **Single instance.** Launch while running; launch with protocol URL; inspect processes/tray. | Second process exits 0; first focuses/restores; protocol URL handled; one tray/window. | A | `pgrep`, screenshots |
| D-12 | P1 | **Port collision.** Start `python3 -m http.server 44548 --bind 127.0.0.1`; launch app. | Native dialog names port 44548; app exits non-zero; no blank window/hang; after freeing port launch succeeds. | A | dialog screenshot, exit code |

### 3.6 Updates

Run only on a disposable install/copy. `PLOTINA_QA_UPDATES=1` and
`PLOTINA_UPDATE_FEED_URL=http://127.0.0.1:9440` point the updater at the local
feed harness; production builds ignore both.

| ID | P | Scenario and steps | Expected / pass criterion | Auto | Evidence |
|---|---|---|---|---|---|
| U-01 | P0 | **Update button/entry visible.** Open tray/menu; check "Check for updates…"; on deb/rpm check guidance. | Update entry/button present on AppImage/NSIS; deb/rpm says package-manager managed and does not download. | S | screenshot |
| U-02 | P0 | **No update.** Current `.18`; local feed version `.18`; trigger check. | "You're up to date" dialog; no download; current app unchanged. | A | dialog screenshot, log |
| U-03 | P0 | **Update available AppImage.** Local feed `.19` with a copy of the AppImage and correct sha512; trigger check; install; restart. | Downloads; sha512 verified; swaps; restart shows `.19`; old profile/session retained. | A | version before/after, log |
| U-04 | P0 | **Update available NSIS.** Local feed `.19` setup exe; trigger check; install; restart. | Downloads; sha512 verified; runs `/S --updated`; restart shows `.19`; no elevation. | A | version before/after, installer log |
| U-05 | P0 | **Bad signature/sha512.** Local feed `.19` but corrupt artifact or sha512; install. | Refuses; deletes `.part`; current `.18` intact; error dialog; no partial install. | A | log, version, screenshot |
| U-06 | P0 | **Feed metadata.** Parse `latest-linux.yml`/`latest.yml` from the release; compare asset names/sha512. | AppImage entry selected (not deb); every `url` exists in release; version matches tag; sha512 matches file. | A | parser output, base64 sha512 check |
| U-07 | P1 | **Deb/rpm guidance.** Trigger check on deb/rpm. | Message names `apt`/`dnf`; no download; no error dialog. | A | screenshot |
| U-08 | P1 | **Downgrade.** Local feed offers `.17`; current `.18`. | `.17` is not offered; no download; no install. | A | log |
| U-09 | P2 | **Read-only AppImage location.** Run from a root-owned/read-only dir; update `.19`. | Cannot swap; saves verified image to `~/Downloads`; dialog names path; running app untouched. | S | screenshot, file listing |

### 3.7 Resilience and security

| ID | P | Scenario and steps | Expected / pass criterion | Auto | Evidence |
|---|---|---|---|---|---|
| R-01 | P1 | **Renderer crash.** `Page.crash` via CDP (or test hook); inspect dialog; reload. | Dialog offers Reload/Quit; one reload succeeds; session/state survives; no loop. | A/S | logs, screenshots |
| R-02 | P1 | **Main process kill.** `kill -9` main; relaunch; inspect state. | Relaunch works; no corrupt window-state/session; single instance clean; no orphan process. | A | `pgrep`, logs |
| R-03 | P2 | **OS reboot.** Reboot E1/E4m; launch. | Session persists (same shell); window state sane; updater does not reinstall. | M | screenshots |
| R-04 | P0 | **Renderer isolation.** In DevTools: `typeof require`, `typeof process`, `typeof module`; inspect SSO popup. | All `undefined` in app and popup; no `window.electron` leak; preload only exposes documented API. | A | console output |
| R-05 | P0 | **Navigation blocking.** Send `file:///etc/passwd`, `javascript:alert(1)`, `smb://...`, unknown scheme links. | Nothing executes/navigates; external http(s) goes to browser; app stays on origin. | A | screenshots, log |
| R-06 | P1 | **Host header.** `curl -H 'Host: evil.test' http://127.0.0.1:44548/`; `curl http://<LAN-IP>:44548/`. | 403/connection refused; server bound loopback only; app still works via localhost. | A | curl output, `ss -ltnp` |
| R-07 | P0 | **Remote media permission.** In SSO popup (remote origin), call `navigator.mediaDevices.getUserMedia`. | Rejects with `NotAllowedError`; no device indicator; main app unaffected. | A/M | console, screenshot |
| R-08 | P2 | **Webview disabled.** Inject `<webview src="...">`; inspect. | No guest attaches; `webviewTag` disabled; no extra process. | A | DOM dump |
| R-09 | P1 | **Error reporting/logs.** Trigger a renderer error; inspect Sentry/log file. | Error recorded under `cinny@v4.12.8-plotina-lite-desktop.18`; no token/PII leak; log path exists. | S | Sentry event, `main.log` |

### 3.8 Web `lite.plotina.cc` unchanged

| ID | P | Scenario and steps | Expected / pass criterion | Auto | Evidence |
|---|---|---|---|---|---|
| W-01 | P0 | **HTTP/assets.** `curl -I https://lite.plotina.cc/`, `sw.js`, `noise/logic.js`, `plotina-icon.svg`. | 200; correct content types; no 404; HSTS/cache headers unchanged. | A | curl headers |
| W-02 | P1 | **Login page.** Load in Chromium; inspect default homeserver, theme, noise slider, source link. | `plotina.cc` default; system theme; noise level 60; source link present; no console errors. | A | screenshot, console |
| W-03 | P1 | **Build identity.** `build-info.json`; compare commit/tag; diff `cinny/patches/`, `apply-noise.py`, `branding.py`, `noise/`. | Web build from same commit/tag; no desktop-only changes; dist has noise/license files. | A | JSON, `git diff` |
| W-04 | P2 | **Web call/noise smoke.** Existing agent call test if available; check `__plotinaNoiseStats`. | Call joins; noise processed; no regression caused by shared `noise/` changes. | S | stats, screenshot |

## 4. Sequenced schedule (after the build)

Assumptions: the tag was cut the night before; CI produced a **draft** release by
07:00; `qa-lead` staged artifacts and `.17` baselines by 08:00. Times are
relative to the QA morning (T0).

| Slot | Track / agent | Environment | Scenarios | Needs / isolation |
|---|---|---|---|---|
| T-1 22:00 | Build captain `infra-edge` | CI | Tag `.18`; draft release; `SHA256SUMS` | Old Tauri workflow already retired; no `/dl` switch yet |
| T0 07:00 | `qa-lead` | `/srv/qa/lite-electron` | Stage `.18` and `.17`; verify checksums; create test rooms | `gh` auth; shared mirror |
| T0 08:00 | All | — | Kickoff, environment reset, account A/B check | Snapshot E3/E4m before destructive tests |
| 08:15–10:30 | **A** `qa-linux-x11` | E1 `:130`, CDP 9401, default profile | I-01, I-07, A-01–A-08, M-01–M-04, D-01–D-06, R-04–R-06 | Artifacts copied; account A; fake media flags |
| 08:15–10:30 | **A2** `qa-wayland` (separate host/netns) | E2 `:131`, CDP 9402 | A-01, D-03–D-07, C-04; repeat A-05/M-01 | KDE Wayland + portal; if no separate host, move to 15:00–16:30 and report slips |
| 08:15–10:30 | **B** `qa-debian` | E3 container `:99`, CDP 9403, `--network none` | I-02, I-06, I-10, A-01, M-03, D-05 | Debian image built once; no host port conflict |
| 08:15–10:30 | **C** `qa-windows` | E4 CI + E4m snapshot | I-04, I-08, I-11, U-02, R-04 | `.17`/`.18` installers; Windows runner; manual VM queued |
| 08:15–10:30 | **D** `qa-web` | E5 | W-01–W-04 | Playwright; account B; no app port |
| 10:30–12:30 | **C2** `qa-windows` (manual) | E4m | A-02, A-03, C-01–C-03, D-07, D-09 | Real devices, SmartScreen, notifications; VM snapshot |
| 10:30–12:30 | **E** `qa-calls` | E1 `:133`, CDP 9405/9406 | C-01–C-07 | Account A + B; fake devices first; real devices manual; TURN |
| 12:30–14:00 | **F** `qa-updater` | E1 `:132`, CDP 9407; local feed `:9440` | U-01–U-09 | Disposable AppImage copy; local feed harness; Windows VM for U-04 |
| 14:00–15:00 | **G** `qa-resilience` | E1/E3 disposable | D-08–D-12, R-01–R-03 | Last on disposable env; port-collision dummy server |
| 15:00–16:00 | `qa-lead` | — | Consolidate evidence, dedupe, severity | All evidence dirs populated |
| 16:00 | `qa-lead` | — | Draft morning report; GO/NO-GO recommendation | P0/P1 counts, blockers |
| T+1 09:00 | `qa-lead` + owners | — | Final morning report; release decision | See §6 template |

Parallelization note: A and E/F/G all use E1 and port 44548, so they are
**sequential** on the same host. A2 (E2 Wayland) needs a separate host or
network namespace; otherwise it takes the 15:00–16:30 slot and the report moves
to T+1 noon. B/C/D run in parallel with A; C2 (Windows manual) runs in parallel
with E on a different machine.

Each agent must report at the end of its slot: pass/fail per ID, evidence path,
blockers, and any deviation from the matrix. Do not silently skip a P0.

## 5. Blockers and decision log

### 5.1 The WebRTC/Tauri finding

**Timeline/evidence**

- `.16` attempted in-app SSO only; calls still failed.
- `.17` added `cinny/desktop-patches/0003-plotina-linux-webrtc-media.patch`,
  which sets WebKitGTK `enable-media-stream`/`enable-webrtc` and installs a
  deny-by-default `UserMediaPermissionRequest` handler. This is necessary but
  not sufficient.
- The `.17` release notes state: calls work only where WebKitGTK was built with
  `ENABLE_WEB_RTC`; distribution builds (Ubuntu/Arch) do not enable it, so
  `RTCPeerConnection` is absent regardless of app settings.
- QA reproduction on Arch/CachyOS WebKitGTK 2.54.2: in the Tauri `.17` app,
  `typeof RTCPeerConnection === "undefined"`; the call UI reports "browser does
  not support WebRTC". The WebKit settings exist in the library, but the
  compile-time feature is off.
- This cannot be fixed by a Tauri plugin, capability, or runtime flag; it is a
  property of the distro's WebKitGTK build. Shipping a custom WebKitGTK would
  be a larger maintenance burden than Electron's bundled Chromium.

**Decision:** replace the shell with Electron (D1 in the migration doc). Freeze
Tauri feature work; `.17` is the last Tauri build. Electron's Chromium provides
WebRTC, `getUserMedia` and `getDisplayMedia` on every target.

**Consequences:** new shell features, new packaging, new updater, and a required
re-login because WebKitGTK storage cannot be read by Chromium. The old profile is
preserved; encrypted history recovery depends on Local Backup/key backup.

### 5.2 Open blockers

| ID | Blocker | Owner | Exit condition | Status |
|---|---|---|---|---|
| B1 | Wayland screen share via portal/picker not yet proven | `desktop-shell` | C-04 passes on a real KDE Wayland session, or a signed P1 limitation + release note | Open |
| B2 | Windows NSIS `.17`→`.18` identity/cleanup not yet proven | `packaging-ci` | I-08 passes on E4 with one entry and sentinel intact | Open |
| B3 | Updater local feed harness (`PLOTINA_QA_UPDATES`) not yet implemented | `desktop-shell` | U-02–U-05 pass against local feed | Open |
| B4 | Signing/Authenticode decision | `security-review` | Decision recorded; release notes accurate; `app-update.yml` consistent | Open |
| B5 | Data-migration communication (re-login/key backup) | `qa-lead` | A-07 passes with backup; release notes published | Open |
| B6 | MSI cross-grade from `.17` | `packaging-ci` | I-12 documented; no half-install | Open (likely accepted limitation) |

### 5.3 Decision log

| Date | ID | Decision | Evidence | Owner | Status |
|---|---|---|---|---|---|
| 2026-11-06 | D1 | Tauri `.17` is the last Tauri build; migrate to Electron | `.17` release notes; `RTCPeerConnection` undefined on Arch WebKitGTK; `0003` cannot add compile-time `WEB_RTC` | product + `desktop-shell` | Accepted |
| 2026-11-06 | D2 | First Electron tag is `.18`; keep the tag series | `.17` published; no parallel namespace needed | `infra-edge` | Accepted |
| 2026-11-07 | D3 | Keep `http://localhost:44548`; no custom scheme | Cinny `src/sw.ts` authenticated media fetch; `src/index.tsx` SW registration | `desktop-shell` | Accepted |
| 2026-11-07 | D4 | No automatic session/E2EE migration; require re-login | WebKitGTK vs Chromium storage; unsupported LevelDB copy | product + `desktop-shell` | Accepted |
| 2026-11-07 | D5 | NSIS is the Windows cross-grade path; MSI clean install until proven | electron-builder/Tauri MSI upgrade codes are not guaranteed to match | `packaging-ci` | Accepted |
| 2026-11-07 | D6 | Unsigned builds; sha512-only verification until a cert exists | No Authenticode cert; `.17` already unsigned | `security-review` | Accepted |
| 2026-11-07 | D7 | Fixed port 44548; fail loudly on collision | Origin is part of storage/SW identity | `desktop-shell` | Accepted |
| 2026-11-07 | D8 | Tray/menu update entry; optional Settings button later | Avoid patching Cinny UI for shell behavior | product + `desktop-shell` | Accepted |
| 2026-11-07 | D9 | Retire Tauri workflow before `.18` | Prevent dual release/assets overwrite | `infra-edge` | Accepted |

## 6. Morning report template

Fill this at T+1 09:00 and attach the evidence root. Keep it short; link, don't
paste logs.

```markdown
# Plotina Lite Desktop <tag> — QA morning report

**Verdict:** GO / NO-GO / GO WITH KNOWN ISSUES
**Build:** tag `<tag>` · commit `<sha>` · workflow run `<url>` · draft/published
**Artifacts:** `/srv/qa/lite-electron/<tag>/` · `SHA256SUMS` verified: yes/no
**Matrix:** P0 `<pass>/<total>` · P1 `<pass>/<total>` · P2 `<pass>/<total>` · skips `<n>` (reasons)

## Coverage
| Environment | Agent | P0 | P1 | P2 | Notes |
|---|---|---|---|---|---|
| E1 Arch/KDE X11 | qa-linux-x11 |  |  |  |  |
| E2 Arch/KDE Wayland | qa-wayland |  |  |  |  |
| E3 Debian 12 | qa-debian |  |  |  |  |
| E4 Windows CI/manual | qa-windows |  |  |  |  |
| E5 lite.plotina.cc | qa-web |  |  |  |  |

## Blockers (release-stopping)
- `<ID>` `<env>` `<summary>` — evidence `<path>` — owner `<role>`

## Regressions / failures
| ID | Severity | Env | Summary | Evidence | Owner | Status |
|---|---|---|---|---|---|---|

## Accepted known issues
- `<ID>` `<summary>` — why acceptable — release-note text

## Decision log changes
- `<ID>` `<decision>` — owner — status

## Evidence root
`/srv/qa/lite-electron/<tag>/evidence/` (contains screenshots, logs, videos, `xprop`, package metadata)

## Next actions
1. ...
```

## 7. Entry/exit and stop conditions

**Entry:** draft `.18` assets exist and checksums verify; `.17` baselines exist;
E1/E3/E4/E5 provisioned; accounts A/B and test rooms exist; old Tauri workflow
has no tag trigger; test data snapshots taken.

**Exit (GO):** all P0 pass; all P1 pass or signed waiver; every P0/P1 has
evidence; no open B1–B6 blocker that affects the release; `/dl` aliases verified
after publish; release notes include re-login/key-backup/SmartScreen text.

**Stop immediately and report NO-GO if any of these occurs:**

- App crashes or shows a blank window on clean launch in any P0 environment.
- Either SSO flow cannot complete.
- A two-party call has no audio or no video, or screen share crashes the app.
- Updater installs a different/wrong version, or bad sha512 is accepted.
- Renderer has Node/`require` access, or a remote SSO page can reach IPC/devices.
- Uninstall deletes the user profile unexpectedly (beyond the documented
  cross-shell re-login).
- The `.18` tag triggers the old Tauri release workflow or produces two
  conflicting releases.
