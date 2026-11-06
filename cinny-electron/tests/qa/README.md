# QA — Electron Lite regression harness

Executable slice of [`docs/LITE_ELECTRON_REGRESSION.md`](../../../docs/LITE_ELECTRON_REGRESSION.md)
for the **Electron** shell (branch lineage `feat/lite-electron` → packaged
`.18`). One entrypoint, machine-readable results, no product changes.

## Scope (per 2026-11-07 QA direction)

Tauri `.17` → Electron upgrade/migration scenarios (matrix I-06/I-07, A-07,
A-08) are **deprioritized** — essentially no users have the old Tauri build.
This harness targets **clean installs of Electron Lite** and **Electron→Electron
update paths** (no-update, valid update, tampered sha512, QA-feed gating), plus
session/messaging, WebRTC, SSO, visuals, single-instance and window-state.

## Run

```bash
# unpackaged prototype (dry-run mode, uses its node_modules/electron):
cinny-electron/tests/qa/run-regression.sh /path/to/cinny-electron            # prototype dir (QA_DIST or a frozen dist is used)

# packaged artifacts (the .18 QA pass):
cinny-electron/tests/qa/run-regression.sh Plotina-Lite-Desktop-4.12.8-plotina.18.AppImage
cinny-electron/tests/qa/run-regression.sh Plotina-Lite-Desktop-4.12.8-plotina.18.deb   # needs dpkg-deb
```

Every run gets its own Xvfb display (`:130`+free), its own CDP port (`9401`+free),
its own updater-feed port (`9440`+free), a temp `HOME`/XDG tree, a private dbus
session and a **fake `xdg-open`** first on `PATH` (captures `shell.openExternal`).
A trap reaps everything referencing the run dir; `results.json`/`REPORT.md`/
`screenshots` stay under `--out`.

The Matrix token is read from `--token-file` (default
`/home/hermes/.hermes/cache/qa-matrix-token`) and is **never printed** — the
report writers redact it defensively.

## What is checked (scenario ↔ matrix)

| ID | Check | Matrix | P | Automated how |
|---|---|---|---|---|
| L-01 | clean launch, login page, title, version | I-01, A-01 | P0 | CDP + HTTP + `--version` |
| L-02 | WM_CLASS + `_NET_WM_ICON` ≥128px | D-06 | P0 | `xdotool`/`xprop` |
| V-01 | theme follows prefers-color-scheme, dark+light shots | D-03 | P0 | CDP `Emulation.setEmulatedMedia` |
| W-01 | `RTCPeerConnection` offer, fake-media `getUserMedia` | C-01 prereq | P0 | CDP eval (+`--use-fake-device-*`) |
| S-01 | SSO popup: exactly one child, opener token handoff, self-close | A-02/A-03 | P0 | synthetic token + CDP Network sniff |
| S-02 | `cc.plotina.chat://` token handoff, second proc exits 0 | A-02/D-02 | P1 | deep-link spawn |
| D-01 | external links → OS browser (fake xdg-open), no in-app window | D-01/R-05 | P0 | fake `xdg-open` log |
| M-01 | injected session; send echo + REST inbound received | M-01/A-04..A-06 | P0 | CDP + Matrix REST |
| R-01 | session survives restart (no re-login) | A-05/A-06 | P0 | kill + relaunch same profile |
| D-08 | window bounds persist across quit+relaunch | D-08 | P1 | CDP `Browser.setWindowBounds` |
| D-11 | second launch exits 0, no second window | D-11 | P0 | dup spawn |
| V-02 | noise dropdown contrast ≥4.5:1 (if settings reachable) | D-04 | P1 | CDP computed styles |
| U-00 | feed fixtures: sha512/size correct; tampered digest differs | U-06 | P1 | `updater-feed.mjs` self-verify |
| U-02 | no-update feed (0.0.1) → not offered/downloaded | U-02/U-08 | P0 | local feed + access log |
| U-03 | valid update advertised → app alive, install untouched until confirm | U-03 | P0 | local feed |
| U-05 | tampered sha512 → refused, install fingerprint unchanged | U-05 | P0 | local feed |
| U-07 | `PLOTINA_UPDATE_FEED_URL` **without** `PLOTINA_QA_UPDATES=1` is ignored | U-01/R-06 | P1 | local feed |

Skips are honest: scenarios that need shell features the Phase-1 prototype
does not have (e.g. the updater, B3) report `SKIP` with the reason and what
*was* verified instead (fixtures, feed server, fingerprint guard).

## Phase-2 contract for the packaged build

The updater scenarios talk to the app only via the environment contract
already named in the matrix:

* `PLOTINA_QA_UPDATES=1` enables the QA feed path; **production builds must
  ignore `PLOTINA_UPDATE_FEED_URL` when this is unset** (checked by U-07).
* `PLOTINA_UPDATE_FEED_URL=http://127.0.0.1:PORT/<case>/` points
  `electron-updater` at a generic feed. `latest-linux.yml` format matches
  electron-builder (base64 sha512, `size`, `path`, `files[]`) —
  `updater-feed.mjs` generates all three cases; `verify` mode self-checks them.
* The install must never be replaced without an explicit user install action:
  every updater scenario hashes the target before/after (`installFingerprint`).

## Files

```
run-regression.sh   entrypoint: isolation, daemons, trap, calls regression.mjs
regression.mjs      scenario registry + assertions (CDP over global WebSocket)
updater-feed.mjs    feed fixture generator + static feed server (also standalone CLI)
lib/cdp.mjs         tiny CDP client + polling helpers
lib/launch.mjs      target resolution (AppImage/deb/unpacked/prototype) + process mgmt
lib/report.mjs      results.json + REPORT.md with token redaction
bin/xdg-open        fake OS-browser handler (records URLs)
```

## Standalone feed harness

```bash
node updater-feed.mjs gen --dir /tmp/feed [--artifact some.AppImage]
node updater-feed.mjs verify --dir /tmp/feed
node updater-feed.mjs serve --dir /tmp/feed --port 9440
```
