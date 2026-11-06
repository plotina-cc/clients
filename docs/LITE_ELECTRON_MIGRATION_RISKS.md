# Plotina Lite Desktop: Tauri → Electron migration risks

Status: research note, 2026-11-07. Scope: the Plotina Lite Desktop client in this
repository (`cinny/`, Tauri v2) and its planned Electron shell. No product code,
tags, workflows, or `/dl` were changed by this note; the only deliverable is this
document.

Method: source review of the shipped `.17` tag, the pending updater work, the
Element Desktop updater (the closest working Electron precedent in this repo),
`tauri-plugin-updater` 2.10.1 and `electron-builder` 26.16.1 sources, plus local
probes on Linux with the real Tauri minisign key and Electron 44.4.5. The probes
are reproducible from Appendix A.

---

## 0. Summary and decisions

| Area | Finding | Decision |
|---|---|---|
| **Cross-shell update** | The Tauri updater can cryptographically accept an Electron AppImage/NSIS: both are opaque bytes to the plugin, and the existing minisign key can sign them (proved below). But **shipped `.17` has no updater at all**, and Windows cannot be upgraded cleanly by simply running the Electron NSIS. | **Manual reinstall is the recommendation.** Build a one-off `.18` updater only if the installed base justifies it; then Linux AppImage can cross-grade directly, Windows needs a cleanup step. |
| **Session/data** | Linux Tauri is WebKitGTK (`localStorage` in SQLite, IndexedDB in SQLite); Electron is Chromium (LevelDB). File-level migration is impossible. A login-token-only import is technically possible and was prototyped, but it does not migrate the E2EE crypto store. Windows Tauri is WebView2 (Chromium), so a profile copy is technically plausible there. | **Require re-login on Linux.** Optionally import non-secret settings; token import only as an explicit opt-in with an E2EE warning. On Windows, treat a Chromium profile copy as experimental; do not make it the only path. |
| **Windows installer identity** | Tauri NSIS and electron-builder NSIS are different products: different uninstall keys, different install directories. `appId` does not make Electron an upgrade of Tauri. | **Uninstall Tauri first** (manual or custom NSIS pre-init). Never ship MSI as the auto-update payload for an NSIS install. |
| **Signing/feed** | Electron needs `latest.yml`/`latest-linux.yml`, SHA-512, and (for NSIS) `.exe.blockmap`; `app-update.yml` must point at `plotina-cc/clients`. The existing Element setup is unsigned and relies on TLS + SHA-512 only. | **Minimum viable secure**: Authenticode-sign the Windows installer and app, keep SHA-512 verification, publish signed update manifests if possible (electron-builder v27+). Keep the Tauri minisign key for the one-time transition only. |
| **Packaging** | The Phase-1 prototype deliberately serves `http://localhost:44548` to preserve the Tauri origin and service-worker/secure-context behaviour. A measured WM_CLASS (`plotina-lite-desktop`) does not match the existing `plotina-lite.desktop`; a 512 px window icon leaves `_NET_WM_ICON` empty. | **Keep localhost:44548 for Phase 1**, harden the server and fix desktop identity. Custom scheme is viable but changes the origin and therefore gives up migration. Finish or remove the `cc.plotina.chat` protocol handler; do not leave it half-registered. |

The rest of this document explains the evidence and the exact failure modes.

---

## 1. Cross-shell update: can `.17` become Electron?

### 1.1 First, an assumption check: `.17` has no updater

The task describes `.17` as a Tauri build with a minisign updater. **The tag in
this repository does not have one.** At
`v4.12.8-plotina-lite-desktop.17`:

- `cinny/tauri.plotina.json` sets `bundle.createUpdaterArtifacts: false` and
  `plugins.updater.endpoints: []`.
- `cinny/README.md` in that tag describes the file as “build override: no
  beforeBuildCommand, updater disabled”.
- The upstream `src-tauri/Cargo.toml` still compiles the `updater` feature by
  default, but `AppHandle::updater()` returns `Error::EmptyEndpoints` when the
  endpoint list is empty. The app has no feed to check, and the upstream startup
  prompt either does not run or immediately gives up.
- The `.17` app reports the upstream version `4.12.8`; the `build_config.py`
  version stamping (`4.12.818` for `.18`, ...) is part of the pending updater
  work, not the `.17` tag.

The updater-enabled configuration exists only in the uncommitted
`feat/lite-updater` worktree:

```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDlFQjI2QjE3NEVFRkYwQTgK...",
      "endpoints": ["https://plotina.cc/dl/lite/latest.json"]
    }
  }
}
```

That work would produce `.18` (`4.12.818`). **Consequences:**

- If `.17` is already in users' hands, it will never discover Electron. No
  signature trick changes that; there is no code path that reads a feed.
- If the migration wants an automatic path, the last Tauri build must be a new
  `.18` with the updater patch, and users on `.17` and older still need one
  manual reinstall to reach `.18`.
- If `.17` was built by a different pipeline outside this repository and really
  carries an updater, re-run the signature probe in Appendix A against that
  build's published public key; the format analysis below still applies.

### 1.2 Tauri updater manifest format (what old clients accept)

`tauri-plugin-updater` 2.10.1 expects a static JSON document:

```json
{
  "version": "5.0.0",
  "notes": "Plotina Lite Desktop 5.0.0",
  "pub_date": "2026-11-07T18:00:00Z",
  "platforms": {
    "linux-x86_64": {
      "url": "https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage",
      "signature": "<verbatim contents of Plotina-Lite-Desktop.AppImage.sig>"
    },
    "windows-x86_64": {
      "url": "https://plotina.cc/dl/Plotina-Lite-Desktop-setup.exe",
      "signature": "<verbatim contents of Plotina-Lite-Desktop-setup.exe.sig>"
    }
  }
}
```

Facts that matter:

- `version` is semver and must be **strictly greater** than the running app's
  version. An old `.18` client at `4.12.818` accepts `5.0.0` or `4.12.900`, but
  not `4.12.818`.
- `platforms` keys are the target triple without the installer suffix:
  `linux-x86_64`, `windows-x86_64`. The plugin first tries
  `<os>-<arch>-<installer>` (for example `linux-x86_64-appimage`) and then the
  bare key. The bare keys are enough for one artifact per platform.
- `signature` is **not** raw minisign text. `tauri build` writes a `.sig` file
  that is one base64 line wrapping the minisign document. The plugin does
  `base64_to_string(signature)` and then `minisign_verify::Signature::decode`,
  and verifies the downloaded bytes with `allow_prehashed = true`
  (`tauri-plugin-updater-2.10.1/src/updater.rs:1453-1462`). The manifest must
  carry the `.sig` file's content verbatim; a hand-written minisign text fails.
- The manifest itself is not signed; trust in the URL comes from HTTPS, and trust
  in the payload comes from the minisign signature. An attacker who can write
  `/dl/lite/latest.json` can serve a different URL, but cannot make a payload
  verify without the private key.
- `createUpdaterArtifacts: true` signs the **raw** AppImage and the **raw** NSIS
  `-setup.exe`. The legacy `"v1Compatible"` signs a different file
  (`.AppImage.tar.gz` / `.exe.zip`), which is not what this feed publishes
  (`cinny/scripts/updater_manifest.py:20-57`).
- Two payload shapes are valid, and the signature always covers the bytes at the
  manifest `url`, not the file inside an archive:
  - **raw** (`createUpdaterArtifacts: true`): sign the `.AppImage` / `setup.exe`;
  - **archive** (`"v1Compatible"`): sign the `.AppImage.tar.gz` / `.exe.zip`.
    `tauri-plugin-updater` 2.10.1 has the `zip` feature on by default, so it can
    unpack an archive and install the inner AppImage/EXE. If the last Tauri
    updater was built with `v1Compatible` (upstream's default), the manifest must
    point at the archive and the `.sig` must cover the archive. The pending
    `.18` config uses raw, so do not mix the two in one feed.

The pending client patch is
`cinny/desktop-patches/0003-plotina-updater-client-support.patch`. It adds
`plotina_install_kind` (so the UI can refuse deb/rpm/MSI), removes the startup
prompt, and adds `src-tauri/tests/updater_signature.rs`, which replays the
plugin's `base64 -> minisign_verify` path against a built artifact. The older
`0002-plotina-sso-in-app-sign-in.patch` already contains the
`#[cfg(feature = "updater")] use tauri_plugin_updater::UpdaterExt;` import; the
updater feature is in upstream's default features. The actual feed policy lives
in the Tauri config, not in the patch.

### 1.3 What the Tauri plugin does with the payload

**Linux** (`updater.rs:976-1039`):

- Only an AppImage install takes this path. The plugin's `bundle_type()` is a
  compile-time value (`appimage`, `deb`, `rpm`); for `.18` it is `AppImage`.
- It takes `$APPIMAGE` as the target file, renames the running image to a
  temporary directory on the same mount, writes the downloaded bytes to the
  original path, and restores the previous permission bits. It does **not**
  check that the new bytes are an AppImage. An Electron AppImage is therefore
  accepted and becomes the file at `$APPIMAGE`.
- If the user launched with `--appimage-extract-and-run`, `$APPIMAGE` is unset;
  the plugin falls back to `current_exe()`, which is inside the read-only mount.
  The update cannot work. The pending `install_kind.rs` recognizes the
  `.AppImage` path in `current_exe`, but the plugin itself does not.
- If the install is deb/rpm, `bundle_type()` routes to `install_deb` /
  `install_rpm`; an Electron AppImage fails `infer::archive::is_deb` and the
  update is rejected. Package installs must update through apt/dnf.

**Windows** (`updater.rs:787-865`, `config.rs:14-47`):

- The plugin writes the downloaded `.exe` to a temp file, treats any PE as NSIS,
  and calls `ShellExecuteW` on it. It exits immediately after launching it.
- Arguments depend on the **old** client's `plugins.updater.windows.installMode`
  (default `passive`):
  - `passive`: `/P /R /UPDATE /ARGS <current app args>`
  - `quiet`: `/S /R /UPDATE /ARGS <current app args>`
  - `basicUi`: no `/P` or `/S`, plus `/UPDATE /ARGS ...`
- `/P`, `/R`, `/UPDATE`, and `/ARGS` are **Tauri NSIS** conventions.
  electron-builder's NSIS understands `/S` (silent) and `--updated` (double
  dash), not `/P` or `/UPDATE`. Therefore:
  - default passive `.18` → the Electron installer will show its normal
    one-click UI (not silent), install, and probably run the app;
  - quiet `.18` → `/S` makes electron-builder's NSIS install silently; the
    extra `/R /UPDATE /ARGS` are likely ignored, but this must be tested;
  - either way, the Electron installer is a **different product** and does not
    remove the Tauri install (section 3).
- An MSI payload is detected by magic and run with `msiexec /i ... /passive
  /promptrestart AUTOLAUNCHAPP=True`. That is not a supported upgrade path from
  a Tauri NSIS install and would leave two products; do not put an MSI in the
  bare `windows-x86_64` feed.

### 1.4 Element/electron-updater format (the steady-state Electron feed)

The Element Desktop shell in this repo already implements a working
GitHub-releases updater in `element-desktop/desktop/updater.ts`. It is the best
template for Lite:

- `resources/app-update.yml` is generated by electron-builder from the publish
  config and must contain `provider: github`, `owner: plotina-cc`,
  `repo: clients` (`updater.ts:1-40, 176-203`).
- It fetches `latest.yml` on Windows and `latest-linux.yml` on Linux from the
  newest non-draft, non-prerelease releases (`updater.ts:84-86, 245-300`).
- `parseLatestYml` reads `version`, the first `files[].url`, the top-level
  `sha512`, and `releaseDate` (`updater.ts:210-224`). The top-level fields are
  emitted by electron-builder 26; electron-builder 27 defaults to `files[]` only
  and would require a parser update.
- It downloads the artifact named by the YAML, verifies its SHA-512, and:
  - Windows: runs `setup.exe /S --updated` and quits (`updater.ts:548-575`);
  - Linux AppImage: downloads, verifies, atomically renames over the running
    image, and relaunches (`updater.ts:378-546`);
  - Linux deb: reports that the package manager owns updates and does nothing.
- Blockmaps: electron-builder 26 writes a standalone `.exe.blockmap` for NSIS
  and embeds the AppImage blockmap inside the `.AppImage` (reported as
  `blockMapSize` in `latest-linux.yml`). The Element updater does full downloads
  and ignores blockmaps; electron-updater's built-in updater uses them for
  differential downloads. If the blockmap is missing, differential download
  falls back to a full download (or errors, depending on version); publish it
  anyway.

**Format comparison:**

| Concern | Tauri `.18` | Electron / electron-updater |
|---|---|---|
| Manifest | `latest.json` (custom JSON) | `latest.yml` / `latest-linux.yml` |
| Version | semver, `version` | semver, `version` |
| Platform key | `linux-x86_64`, `windows-x86_64` | separate YAML per platform |
| Payload | AppImage, NSIS `.exe` | AppImage, NSIS `.exe` |
| Integrity | minisign over exact bytes | SHA-512 over exact bytes |
| Signature | Ed25519/minisign, key pinned in app | optional Authenticode (Windows); unsigned Linux |
| Blockmap | none | NSIS `.exe.blockmap`; AppImage embedded |
| Feed auth | HTTPS + pinned minisign key | HTTPS + release-account trust, SHA-512 |
| Old Tauri can read it | yes | no |

### 1.5 Does the old Tauri updater accept an Electron artifact? Local proof

The existing Tauri private key is at `~/.tauri/plotina-lite.key` (0600,
password-protected; public half in `~/.tauri/plotina-lite.key.pub`). It is the
key whose public half is in the pending `.18` config. I signed a **real Electron
AppImage** (the Plotina Element/Electron build
`Plotina-Desktop-1.12.32-plotina.38.AppImage`, 209 MB) and a **real
electron-builder NSIS** (`Plotina-Desktop-setup.exe`, 185 MB, from the Element
build), built a two-platform `latest.json` with the pending
`updater_manifest.py`, and verified both signatures with an independent stdlib
implementation of the same minisign-verify algorithm:

```console
$ tauri signer sign Plotina-Lite-Desktop.AppImage
$ tauri signer sign Plotina-Lite-Desktop-setup.exe
$ python3 cinny/scripts/updater_manifest.py build \
    --version 5.0.0 \
    --notes 'Cross-grade test: Electron AppImage + NSIS signed with the Tauri minisign key' \
    --platform linux-x86_64=Plotina-Lite-Desktop.AppImage.sig \
    --platform windows-x86_64=Plotina-Lite-Desktop-setup.exe.sig \
    --out latest-full.json
wrote latest-full.json
version 5.0.0, pub_date 2026-11-06T19:08:31Z
  linux-x86_64     https://plotina.cc/dl/Plotina-Lite-Desktop.AppImage  key id A8F0EF4E176BB29E  signed from Plotina-Lite-Desktop.AppImage
  windows-x86_64   https://plotina.cc/dl/Plotina-Lite-Desktop-setup.exe  key id A8F0EF4E176BB29E  signed from Plotina-Lite-Desktop-setup.exe

$ python3 cinny/tests/qa_lite/minisign_check.py verify \
    --pubkey @/home/hermes/.tauri/plotina-lite.key.pub \
    --signature @Plotina-Lite-Desktop.AppImage.sig \
    --file Plotina-Lite-Desktop.AppImage
OK keyid=a8f0ef4e176bb29e
```

Flipping one byte of the AppImage made the same verifier print
`FAIL invalid signature (message)` and exit 2. This proves the cryptographic
part: the old updater will verify Electron bytes if the manifest carries a
signature made with the shipped key, and it will reject tampering. The probe
used raw artifacts; if the old updater was built with `v1Compatible`, repeat it
with the `.AppImage.tar.gz` / `.exe.zip` files instead.

What the probe does **not** prove: that the Electron installer runs correctly
with Tauri's arguments, and that Windows product identity is handled. Those are
section 3 and must be tested on a Windows runner.

### 1.6 Exactly what old clients will do

Assuming the current `.18` updater (manual “Check for updates” in Settings, no
startup prompt):

| Installed build | Linux AppImage | Linux deb/rpm | Windows NSIS | Windows MSI |
|---|---|---|---|---|
| `.17` and older | Nothing: no feed, no prompt, no network. Manual download/reinstall. | Nothing; `apt`/`dnf` only. | Nothing; manual. | Nothing; manual. |
| `.18` with updater | Check → GET `latest.json` → verify → replace `$APPIMAGE` bytes → restart into Electron. Works. | `install_kind = package`; UI shows manual instructions; no feed. | Check → GET → verify → run Electron `setup.exe` with `/P /R /UPDATE /ARGS` (or `/S` if quiet) → Electron installs **alongside** Tauri; Tauri exits. Old Tauri remains unless cleaned up. | `install_kind = msi`; UI shows manual instructions. |
| `.18` with quiet + cleanup-aware Electron NSIS | Same as above. | Same. | Check → silent Electron install; custom NSIS removes the old Tauri product; clean. | Manual. |

Important: even for `.18`, the pending UI makes the update a **user action**, not
a background auto-update. “Automatic” in this document means “inside the app,
after one click”, not “silent at startup”.

### 1.7 Decision: manual reinstall, or a one-off `.18` bridge?

**Recommendation: one-time manual reinstall.**

Reasons:

1. `.17` cannot update. Reaching it requires a new `.18` release, a new signing
   run, and a feed that must later be frozen. That is a lot of machinery for a
   single transition.
2. On Linux, a binary swap does not preserve the session anyway (section 2), so
   the user has to log in again either way. The auto-update saves a download,
   not a login.
3. On Windows, a naive binary swap leaves two products and can re-offer the same
   update from the old Tauri shortcut. Cleaning that up correctly is more work
   than a manual uninstall/install.
4. A manual reinstall lets us run the new first-run migration/onboarding and
   delete the old profile only after verification.

If the installed base is large enough that a one-click path is required, the
minimum viable automatic design is:

1. Ship `.18` Tauri with the pending updater patch; set
   `plugins.updater.windows.installMode: "quiet"` so the old client passes `/S`.
2. Build Electron `5.0.0` (higher than `4.12.818`) and sign the AppImage and
   NSIS `setup.exe` with the existing Tauri minisign key.
3. Publish `latest.json` with `linux-x86_64` and `windows-x86_64` pointing at
   the stable `/dl` names; keep both `.sig` files next to the artifacts.
4. On Windows, do not ship a stock electron-builder NSIS as the payload. Either:
   - add a `nsis.include` `customInit` to the Electron installer that detects
     the old Tauri product, runs its uninstaller `/S`, and then installs; or
   - ship a small signed NSIS “bridge” that ignores Tauri's args, runs the real
     Electron installer `/S`, then removes the Tauri product.
   The stock installer can be *executed* by Tauri, but it will not be a clean
   upgrade.
5. After the migration window, change `/dl/lite/latest.json` to a no-update
   manifest (for example version `4.12.818`) or remove it. Otherwise a Tauri
   install that survived on Windows will keep offering Electron forever.
6. Test the whole path on a Windows runner with the exact Tauri args (section
   3.5) and on Linux with a real AppImage replacement.

---

## 2. Data and session migration

### 2.1 Where the data lives

Tauri v2 sets the webview data directory to `app_local_data_dir()` =
`local_data_dir()/<identifier>` (`tauri-2.11.3/src/manager/webview.rs:528-549`,
`path/desktop.rs:253-260`). The identifier is `cc.plotina.chat`. The webview
origin is fixed at `http://localhost:44548` (`install_kind.rs` / the upstream
`lib.rs` port constant).

| Item | Tauri on Linux (measured) | Tauri on Windows (WebView2) | Electron on Linux (prototype) | Electron on Windows |
|---|---|---|---|---|
| Profile root | `~/.local/share/cc.plotina.chat/` | `%LOCALAPPDATA%\cc.plotina.chat\EBWebView\` | `~/.config/Plotina Lite Desktop/` | `%APPDATA%\Plotina Lite Desktop\` |
| localStorage | `localstorage/http_localhost_44548.localstorage` (SQLite) | `Default\Local Storage\leveldb\` | `Local Storage\leveldb\` | `Local Storage\leveldb\` |
| IndexedDB | `databases/indexeddb/v1/http_localhost_44548/<hash>/IndexedDB.sqlite3` | `Default\IndexedDB\http_localhost_44548.indexeddb.leveldb\` | `IndexedDB/http_localhost_44548.indexeddb.leveldb\` | `IndexedDB/http_localhost_44548.indexeddb.leveldb\` |
| Service worker | `serviceworkers/ServiceWorkerRegistrations-8.sqlite3` | `Default\Service Worker\` | `Service Worker\` | `Service Worker\` |
| Cookies | `cookies` (text) | `Default\Network\Cookies` | `Network\Cookies` | `Network\Cookies` |
| OPFS | `storage/` | `Default\File System\` | `File System\` | `File System\` |

Notes:

- The Linux paths are from the live profile on this machine; the Electron
  IndexedDB suffix `.indexeddb.leveldb` was verified with an Electron 44.4.5
  profile probe. WebView2 uses the same Chromium profile layout under its
  `EBWebView` directory; verify the exact `Default` path on a Windows runner
  before writing a migration script.
- Electron `app.getPath('userData')` is `appData/<productName>`; the prototype's
  `productName` is “Plotina Lite Desktop”, hence the space in the directory name.
  If the product later calls `app.setPath('userData', ...)`, all migration paths
  move; pin the path before shipping.
- Tauri's Linux `localStorage` is a SQLite database with one table:
  `ItemTable(key TEXT UNIQUE, value BLOB)`. WebKitGTK stores strings as
  **UTF-16LE** blobs. The measured profile contains
  `i18nextLng` (`en-GB`) and `after_login_redirect_url` (`/`); when logged in,
  the four Cinny session keys are `cinny_access_token`, `cinny_device_id`,
  `cinny_user_id`, `cinny_hs_base_url` (`cinny/upstream/cinny/src/app/state/sessions.ts:32-64`).
- Tauri's Linux IndexedDB is SQLite, not LevelDB:
  `IDBDatabaseInfo`, `ObjectStoreInfo`, `Records`, `BlobFiles`, etc. The current
  profile has only the `checkIndexedDBSupport` database because it is logged
  out; a logged-in profile also has `web-sync-store` (matrix-js-sdk sync) and
  `crypto-store` (Olm/Megolm keys) per
  `cinny/upstream/cinny/src/client/initMatrix.ts:14-36`.

### 2.2 Why a file copy does not work on Linux

`file(1)` on the measured profile:

```
.../localstorage/http_localhost_44548.localstorage: SQLite 3.x database
.../databases/indexeddb/.../IndexedDB.sqlite3:        SQLite 3.x database
.../.config/Plotina-Desktop/Local Storage/leveldb/000003.log: LevelDB log
```

WebKitGTK and Chromium have different storage engines and different on-disk
schemas. Copying `localstorage/*.localstorage` into Electron's
`Local Storage/leveldb` does nothing; copying the IndexedDB SQLite file into
Electron's `IndexedDB/*.leveldb` does nothing. The origin also has to match
exactly (`http://localhost:44548`), which is why the Phase-1 prototype keeps the
fixed port.

### 2.3 What can be migrated: settings, and optionally the login token

**Safe, recommended: non-secret localStorage keys.** `i18nextLng`,
`after_login_redirect_url`, the Cinny settings key, and navigation keys are
plain strings. They can be read from the WebKitGTK SQLite database and injected
into Electron's `localStorage` at the same origin. This preserves theme,
language, and layout preferences without touching authentication.

**Opt-in, not default: the four `cinny_*` session keys.** I prototyped this with
Electron 44.4.5's built-in `node:sqlite`:

1. Read the WebKitGTK database with `DatabaseSync(..., { readOnly: true })`,
   decode each `value` as UTF-16LE, and write a JSON file.
2. In a sandboxed Electron preload, call `ipcRenderer.sendSync` once and set the
   keys with `localStorage.setItem` before the app's scripts run.
3. Load the app at `http://localhost:44548`.

Measured result: the page saw the token and user/homeserver values
(`RESULT {"title":"syt_TESTTOKEN","token":"syt_TESTTOKEN","user":"@test:plotina.cc","hs":"https://plotina.cc"}`).
This proves the mechanism works. It does **not** prove that the resulting
Matrix session is healthy: the IndexedDB sync store and the E2EE crypto store
are still missing.

**What token import costs:**

- The access token is a bearer secret. Writing it to a migration JSON creates a
  second plaintext copy; delete it after import, mode 0600, never log it.
- Cinny's `initRustCrypto()` will initialize a new crypto store for the same
  `device_id`. Other devices may see the same device ID with new identity keys,
  and old encrypted history will not decrypt locally unless the user has key
  backup / key verification. Reusing a device ID with lost Olm keys is not a
  supported "session migration"; it is a new crypto identity wearing an old
  device ID.
- The token may be expired or lack a refresh token. Cinny's fallback session has
  no refresh token; the user may be logged out soon after import.

### 2.4 Full Windows profile copy: technically plausible, still risky

Because Tauri on Windows uses WebView2 (Chromium) and Electron is Chromium, the
following copy can preserve localStorage, IndexedDB (including `crypto-store`),
and session storage **if** the origin is identical (`http://localhost:44548`)
and the Chromium versions are compatible:

```powershell
# Both apps closed. Back up first.
$tauri = "$env:LOCALAPPDATA\cc.plotina.chat\EBWebView\Default"
$electron = "$env:APPDATA\Plotina Lite Desktop"
robocopy "$tauri\Local Storage" "$electron\Local Storage" /E /COPYALL
robocopy "$tauri\IndexedDB"     "$electron\IndexedDB"     /E /COPYALL
robocopy "$tauri\Session Storage" "$electron\Session Storage" /E /COPYALL
```

Risks:

- WebView2 Runtime is evergreen and may be older or newer than Electron's
  bundled Chromium. LevelDB is usually forward-compatible, but IndexedDB schema
  upgrades and service-worker state are not guaranteed. A failed copy can make
  the profile unreadable; keep the Tauri profile untouched and fall back to
  re-login.
- Copying while either app is running can corrupt LevelDB. Kill both first
  (`taskkill /IM plotina-lite.exe /F`, Electron's process name).
- The copied profile includes the E2EE crypto store. That is the only way to
  keep encrypted history without re-login, but it also means a corrupted or
  partially copied store is worse than a clean login.
- `%APPDATA%` vs `%LOCALAPPDATA%`: Electron userData is roaming by default;
  Tauri's WebView2 data is local. Do not copy the whole directories blindly;
  copy only the three stores above.

### 2.5 Decision

**Default: re-login.** It is the only path that is supportable on both
platforms, avoids stale bearer tokens, and gives the E2EE subsystem a clean
start. Offer a one-time “import settings” step (safe keys only). If the product
insists on session continuity:

- Linux: token-only import, explicit warning, key-backup check, and a
  “re-login” fallback. Never claim encrypted history is preserved.
- Windows: experimental full profile copy, only with a backup and a tested
  fallback; do not delete the Tauri profile for at least one release.
- Keep the old Tauri data directory for rollback. A rollback after an Electron
  login would otherwise lose the old session too.

---

## 3. Windows: installer identity, upgrade path, CI verification

### 3.1 What the Tauri NSIS installer is

For the Tauri CLI 2.7.1 used by the Lite build, the stock NSIS template defines
(`tauri-bundler/.../nsis/installer.nsi`, tauri-cli-v2.7.1):

- `UNINSTKEY = Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}`
  → `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Plotina Lite Desktop`
  for the default `currentUser` install.
- Default install directory `$LOCALAPPDATA\Plotina Lite Desktop`.
- `uninstall.exe` in that directory; shortcuts point at `plotina-lite.exe`.
- No MSI ProductCode; NSIS is not Windows Installer. The Tauri `.msi` target is
  a separate WiX product with its own ProductCode/UpgradeCode.

The pending `install_kind.rs` says the identifier `cc.plotina.chat` “is also the
NSIS uninstall key name” and queries
`...\Uninstall\cc.plotina.chat` (`install_kind.rs:166-195`). That does **not**
match the stock Tauri 2.7.1 template, which uses `PRODUCTNAME`. The
`uninstaller_file_present()` probe still detects an NSIS install by the
`uninstall.exe` beside the executable, so the UI behavior is probably correct,
but the registry check is wrong for a stock build. Fix the constant or drop the
identifier key assumption before relying on it. (The older hand-written
`cinny/windows/installer.nsi` uses yet another identity: `Plotina`, install dir
`%LOCALAPPDATA%\Plotina`, uninstall key `...\Uninstall\Plotina`. Check whether
any users still have that build.)

### 3.2 What an electron-builder NSIS/MSI is

electron-builder 26.16.1 (`app-builder-lib/out/targets/nsis/NsisTarget.js`):

- NSIS uninstall key GUID is `UUID.v5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3)`,
  then `...\Uninstall\<uuid>`. It is **not** `appId` and cannot be made equal to
  the Tauri product-name key by choosing the same `appId`.
- Default one-click, per-user install directory is
  `%LOCALAPPDATA%\Programs\<productFilename>` (for example
  `%LOCALAPPDATA%\Programs\Plotina Lite Desktop`), not Tauri's
  `%LOCALAPPDATA%\Plotina Lite Desktop`.
- The shortcut's AppUserModelID comes from `appId`; the executable name comes
  from `executableName`/`productName`. The uninstaller is
  `Uninstall <product>.exe`, but its registry key is the UUID above.
- MSI is a WiX/Windows Installer product with a ProductCode per version and an
  UpgradeCode; it does not share identity with the Tauri MSI unless configured
  to, and electron-updater does not auto-update MSI.

**Conclusion:** Tauri NSIS → Electron NSIS is not an in-place upgrade. It is two
products side by side, with two uninstall entries and two shortcuts unless the
Electron installer explicitly removes the old one.

### 3.3 Can the old Tauri updater install the Electron `setup.exe`?

Yes, mechanically: the Tauri plugin sees a PE, writes it to temp, and runs it.
But:

- With the default `passive` install mode, it passes `/P /R /UPDATE /ARGS ...`;
  electron-builder's NSIS does not recognize `/P` or `/UPDATE`, so the
  “one-click” installer shows its UI and treats it as a first install. It still
  installs.
- With `quiet`, it passes `/S`, which electron-builder does recognize; the
  remaining `/R /UPDATE /ARGS` need a Windows test. Likely ignored, but do not
  assume.
- The installer installs to `%LOCALAPPDATA%\Programs\Plotina Lite Desktop`, not
  over the Tauri directory. The old `%LOCALAPPDATA%\Plotina Lite Desktop` and
  its uninstall key remain. The old shortcut still starts Tauri, which will
  offer the same Electron update again.
- An MSI payload would be run by `msiexec` over the NSIS install; that is worse
  (two products, Windows Installer database mismatch). Do not put an MSI in the
  feed.

### 3.4 Options for a clean Windows transition

**A. Manual uninstall + install (recommended).** Ask the user to uninstall
“Plotina Lite Desktop” in Settings → Apps, then run the Electron installer.
Simple, testable, no updater. The Electron installer can offer to remove old
data; keep it by default.

**B. Side-by-side + first-run cleanup (acceptable).** Let Electron install
alongside; on first Electron run, detect the Tauri uninstall key/install dir,
offer to remove it, and delete the old shortcut. This leaves a window where both
apps exist and the old updater can re-offer Electron. Freeze the Tauri feed
after the migration window.

**C. Custom NSIS pre-init (best automatic path).** Add an `nsis.include` to the
Electron build:

```nsis
!macro customInit
  ; Tauri's updater passes /P (passive) or /S (quiet); make both silent.
  ${GetParameters} $R0
  ${GetOptions} $R0 "/P" $R1
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}

  ; Remove the old Tauri NSIS product before installing.
  ReadRegStr $R2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Plotina Lite Desktop" "UninstallString"
  ${If} $R2 != ""
    ExecWait '$R2 /S _?=$LOCALAPPDATA\Plotina Lite Desktop' $R3
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Plotina Lite Desktop"
    RMDir /r "$LOCALAPPDATA\Plotina Lite Desktop"
  ${EndIf}
!macroend
```

This must be tested for: uninstaller exit code, whether it deletes app data
(Tauri `/S` should not tick the delete-data box, but verify), whether it removes
the shortcut before Electron creates the new one, and whether `/UPDATE` from
Tauri causes electron-builder to skip pages. `customInit` runs after
electron-builder's `initMultiUser`, so it can override `$INSTDIR` if you want
the old path; do not do that unless you also handle the old uninstaller.

**D. Signed bridge executable.** A tiny NSIS “updater” signed with the Tauri key
that ignores Tauri's args, runs the embedded/side-by-side Electron installer
`/S`, then removes the Tauri product. This is the most controllable but the most
moving parts; use only if C cannot be made reliable.

### 3.5 CI-only verification plan (Windows runner)

No local Windows machine is required. Add a `windows-crossgrade` job on
`windows-latest` that builds or downloads both installers and asserts identity.
PowerShell outline:

```powershell
$ErrorActionPreference = 'Stop'

# 1. Fresh-runner baseline: no Plotina keys/dirs.
$tauriKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Plotina Lite Desktop'
$electronRoot = "$env:LOCALAPPDATA\Programs\Plotina Lite Desktop"
$tauriRoot = "$env:LOCALAPPDATA\Plotina Lite Desktop"

# 2. Install the last Tauri NSIS silently.
$p = Start-Process .\Plotina-Lite-Desktop-setup.exe -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Tauri installer exit $($p.ExitCode)" }
if (-not (Test-Path "$tauriRoot\plotina-lite.exe")) { throw 'Tauri exe missing' }
if (-not (Test-Path $tauriKey)) { throw 'Tauri uninstall key missing' }
$tauriVersion = (Get-ItemProperty $tauriKey).DisplayVersion
Write-Host "Tauri $tauriVersion at $tauriRoot"

# 3. Run the Electron installer exactly as the Tauri updater would.
#    Test both the default passive args and a quiet /S run.
$installerArgs = '/P','/R','/UPDATE','/ARGS'   # replace with '/S','/R','/UPDATE','/ARGS' for quiet
$p = Start-Process .\Plotina-Lite-Desktop-electron-setup.exe -ArgumentList $installerArgs -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Electron installer exit $($p.ExitCode)" }

# 4. Assert Electron installed and the old product is still there (stock NSIS).
if (-not (Test-Path "$electronRoot\plotina-lite.exe")) { throw 'Electron exe missing' }
if (-not (Test-Path "$electronRoot\resources\app-update.yml")) { throw 'app-update.yml missing' }
$yml = Get-Content "$electronRoot\resources\app-update.yml" -Raw
if ($yml -notmatch 'owner: plotina-cc' -or $yml -notmatch 'repo: clients') { throw 'wrong feed' }

# 5. Launch Electron, assert it stays alive, then kill it.
$exe = "$electronRoot\plotina-lite.exe"
if (@(Get-Process plotina-lite -ErrorAction SilentlyContinue).Count -eq 0) { Start-Process $exe }
Start-Sleep -Seconds 20
if (@(Get-Process plotina-lite -ErrorAction SilentlyContinue).Count -eq 0) { throw 'Electron did not stay running' }
taskkill /IM plotina-lite.exe /F /T

# 6. If using the cleanup-aware installer, assert the Tauri key/dir are gone.
# if (Test-Path $tauriKey) { throw 'Tauri product was not removed' }

# 7. Authenticode check (only after signing is configured).
$sig = Get-AuthenticodeSignature "$electronRoot\plotina-lite.exe"
if ($sig.Status -ne 'Valid') { throw "Authenticode: $($sig.Status)" }
```

Run the same job for the MSI path (install Tauri MSI, then Electron NSIS) and
assert it is **not** treated as an upgrade; document that MSI users must
uninstall first.

Also test the actual Tauri updater, not just the installer args:

- Build a `.18` Tauri AppImage/NSIS with a QA feed override, or use the existing
  `cinny/tests/qa_lite_updater.sh` harness (it serves a local TLS feed and drives
  the app under Xvfb) with an Electron payload. The harness currently expects a
  `.AppImage.tar.gz`; adapt it to raw AppImage for `createUpdaterArtifacts:true`.
- Assert the old AppImage is byte-identical after a bad signature, and that the
  new Electron AppImage is byte-identical to the payload after a good one.

---

## 4. Signing and the update feed

### 4.1 Artifacts electron-updater needs

For a Lite Electron release built with electron-builder 26.x:

| Platform | Artifacts | Metadata |
|---|---|---|
| Windows | `Plotina-Lite-Desktop-<ver>-setup.exe`, `...setup.exe.blockmap` | `latest.yml` with `version`, `files[].url`, `files[].sha512`, `files[].size`, top-level `path`/`sha512`, `releaseDate` |
| Linux AppImage | `Plotina-Lite-Desktop-<ver>.AppImage` (blockmap embedded; `blockMapSize` in metadata) | `latest-linux.yml` with the same fields |
| Linux deb/rpm | `.deb`, `.rpm` for manual install | no auto-update; package manager |

`app-update.yml` inside `resources/` must contain the GitHub publish target:

```yaml
provider: github
owner: plotina-cc
repo: clients
```

The Element workflow's “Check updater metadata” step is the exact pattern to
copy: build with `--publish never`, pass
`--config.publish.provider=github --config.publish.owner=plotina-cc
--config.publish.repo=clients --config.publish.releaseType=release`, then assert
the packed `app-update.yml` and `latest*.yml` before uploading. This matters
because upstream's electron-builder config builder drops the variant's publish
block; CLI dot-overrides are what actually reach the packaged app.

Do not rename artifacts after electron-builder hashes them. `latest.yml` names
the file by `files[].url`; a later rename makes the feed point at a missing
asset. Stable `/dl` aliases can be additional copies, but the release asset
names must match the YAML.

### 4.2 Keys and secrets

| Secret | Purpose | Status |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` | Sign the **transition** AppImage/NSIS with the existing minisign key | Exists for the `.18` pipeline; back up; do not publish |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` (or Azure Trusted Signing) | Authenticode-sign the Windows app and NSIS installer | New for Electron; required for SmartScreen and update verification |
| `SENTRY_AUTH_TOKEN` | Source-map upload | Existing |
| `GITHUB_TOKEN` / `contents: write` | Create releases and upload assets | Existing |

The Tauri minisign key is **not** an Authenticode certificate. It proves only
that the update payload was signed by the holder of the Tauri key; Windows still
shows “unknown publisher” and SmartScreen warnings for an unsigned installer.
Do not confuse the two in release notes.

### 4.3 What changes in GitHub Actions

The current `build-cinny-desktop.yml` builds Tauri and publishes stable assets.
A Lite Electron workflow should keep the web build/noise/branding steps and
replace the Tauri bundle step with electron-builder. Minimum job graph:

1. **`web`** — build `cinny/dist` exactly as today (noise, branding, Sentry,
   source-map split). Reuse the existing steps; do not duplicate the logic.
2. **`build` matrix (`linux`, `windows`)** — install the Electron project,
   `npm ci`, run electron-builder with `--publish never` and the publish
   overrides above. Set `CSC_IDENTITY_AUTO_DISCOVERY=false` on Linux; enable
   signing on Windows. Upload `*.exe`, `*.exe.blockmap`, `*.AppImage`, `*.deb`,
   `latest.yml`, `latest-linux.yml`.
3. **`updater-tests`** — copy the Element tests
   (`element-desktop/desktop/tests/linux-updater.test.mjs`,
   `update-feed.test.mjs`) or the Lite equivalent; run `node --test`.
4. **`windows-smoke`** — silently install the built NSIS, assert
   `resources/app-update.yml` owner/repo, check the executable and
   Authenticode status, launch and kill the app. The Element workflow's step is
   a working template.
5. **`transition-manifest`** (only for the cross-grade release) — download the
   Electron AppImage and NSIS, sign both with `TAURI_SIGNING_PRIVATE_KEY`, run
   `cinny/scripts/updater_manifest.py build --version 5.0.0 ...`, validate, and
   upload `update-lite-desktop.json`. The edge mirrors it to
   `https://plotina.cc/dl/lite/latest.json` only after checking the artifact
   names, sizes, and SHA-256 against GitHub.
6. **`release`** — download all artifacts, attach `latest*.yml` plus installers
   to the GitHub release. `latest*.yml` must be in the same release as the
   artifacts; electron-updater's GitHub provider looks there.

Keep a **freeze** step or manual runbook: after the transition window, replace
`/dl/lite/latest.json` with a no-update manifest so surviving Tauri installs do
not loop.

### 4.4 Minimum viable secure setup

Current Element precedent is explicit: the app and installers are unsigned, and
the updater does no Authenticode verification
(`element-desktop/desktop/updater.ts:43-61`). Authenticity rests on TLS to
GitHub plus SHA-512 in `latest.yml`; anyone who can write a release can push a
binary that installs silently. That is not acceptable as the Lite default.

Minimum acceptable:

1. **Windows Authenticode**: OV certificate (cheapest) or Azure Trusted Signing.
   Sign the app executable and the NSIS installer in electron-builder so
   `publisherName` is written to `app-update.yml`; keep
   `win.verifyUpdateCodeSignature: true`. Verify with
   `Get-AuthenticodeSignature` in CI.
2. **SHA-512 verification**: keep it; never disable it. It catches corruption
   and casual tampering, not a release-account compromise.
3. **Controlled feed**: publish only from tags through protected GitHub
   Environments; restrict who can create releases; keep `latest*.yml` and
   artifacts in the same release.
4. **Pin tool versions** (`electron-builder`, `electron-updater`, NSIS toolset)
   and check the generated `latest*.yml` in CI.

Stronger (recommended before wide release):

- Use electron-builder v27's **signed update manifests** (Ed25519-signed
  `latest*.yml`, public key in `app-update.yml`) if the upgrade is feasible;
  this closes the “repo write = arbitrary code” gap on both platforms. The
  current repo is on electron-builder 26.16.1, so this is a deliberate upgrade,
  not a config toggle.
- For Linux AppImage, add a detached minisign signature and verify it in the
  custom updater with a pinned key, or rely on the signed manifest above. A
  bare SHA-512 over TLS is the weakest link.

### 4.5 Feed lifecycle

- **Cross-grade feed**: `https://plotina.cc/dl/lite/latest.json` (Tauri format,
  minisign). Only `.18` clients read it. Freeze/remove after migration.
- **Electron steady-state feed**: `latest.yml` / `latest-linux.yml` on
  `plotina-cc/clients` releases (Element pattern). Electron clients read
  `app-update.yml`, not the Tauri endpoint.
- Do not point the Tauri endpoint at `latest.yml`; the formats are incompatible.
- Do not point Electron at `latest.json`; it cannot parse it.

---

## 5. Packaging pitfalls

### 5.1 Localhost vs custom scheme

The Phase-1 prototype (`cinny-electron/src/app-server.js`) uses a fixed
`http://localhost:44548` server and documents why:

1. Cinny registers a service worker (`dist/sw.js`), and Chromium's service
   worker system is most reliable on `http(s)` origins;
2. `http://localhost` is a secure context, so `getUserMedia`/WebRTC work;
3. Cinny uses path-based routing; `file://` breaks `/home/<room>/` and the
   service-worker scope;
4. the Tauri shell used `tauri-plugin-localhost` at the same origin, so
   localStorage/IndexedDB continuity is possible where the engines allow it.

That is the right Phase-1 trade-off **if** Windows profile migration is a goal.
The costs:

- A local TCP listener on 127.0.0.1 that any local process can reach; it serves
  the app's static assets, not secrets, but it is still attack surface.
- The port can be occupied. The prototype's comment says it falls back to an
  ephemeral port, but the code does not implement the fallback: `server.listen`
  rejects and the app fails. A fallback would also change the origin and lose
  storage, so do not silently fall back; show a clear error and ask the user to
  close the other instance.
- If the old Tauri app is still running (or starts at login), it owns port
  44548. The Electron app must detect this and offer to quit the old app, or the
  installer must remove it.
- `localhost` may resolve to `::1` while the server binds `127.0.0.1`; test on
  IPv6-preferring systems or bind both.

A custom scheme (for example `plotina-lite://app/` or `cc.plotina.chat://app/`)
avoids the listener and gives a stable origin, but:

- it changes the origin, so no Tauri localStorage/IndexedDB can be read;
- it needs `protocol.registerSchemesAsPrivileged` with `standard: true`,
  `secure: true`, `supportFetchAPI: true`, `allowServiceWorkers: true` (and
  usually `corsEnabled`/`stream`) before `app.whenReady()`;
- a quick Electron 44.4.5 probe showed `plotina-test://app` and
  `cc.plotina.chat://app` both have `localStorage`, `isSecureContext`, and
  `navigator.mediaDevices`, and service-worker registration succeeded on retry
  but failed intermittently with “The Service Worker system has shutdown.”
  Do not switch without a retry/fallback or a packaged end-to-end test.

**Decision:** keep localhost:44548 for Phase 1. Harden it: bind 127.0.0.1,
reject non-GET/HEAD, path-traversal guard (already present), explicit MIME
types, no directory listing, `Cache-Control: no-cache` for `index.html`,
`config.json`, and `sw.js`, and a CSP that still allows Cinny's wasm/worker
needs. Revisit a custom scheme only if we accept re-login and can prove service
workers on the packaged app.

### 5.2 Service worker

- `sw.js` is registered at the origin root from `cinny/src/index.tsx:33-44`.
  With localhost it works; with a custom scheme it needs the privileges above.
- Do not mark `sw.js` as `immutable` for a year. The prototype's static server
  applies `public, max-age=31536000, immutable` to every non-HTML/non-JSON file,
  which includes `sw.js`; set `no-cache` for it.
- The service worker bridges the Matrix session (`sw-session.ts`); after a
  re-login, make sure the new session is pushed to the worker. A stale worker
  from the old origin/profile can keep an old token; clear site data on logout.

### 5.3 Protocol handler `cc.plotina.chat`

The bundle identifier is `cc.plotina.chat`, and the prototype registers it as a
URI scheme for the SSO deep-link fallback. If we keep it:

- **Linux**: `app.setAsDefaultProtocolClient('cc.plotina.chat')` needs an
  installed `.desktop` file with
  `MimeType=x-scheme-handler/cc.plotina.chat;` and `Exec=... %U`; otherwise it
  returns false (the prototype logs `registered=false` when run unpackaged).
  `update-desktop-database` must run after install.
- **Windows**: electron-builder `protocols` writes
  `HKCU\Software\Classes\cc.plotina.chat`; the installer and the app's
  single-instance handler must agree.
- **macOS**: `CFBundleURLTypes` in `Info.plist`; `open-url` event. macOS is not
  currently shipped, so this is future work.
- **Security**: a URI scheme is a remote input. Accept only the exact
  `cc.plotina.chat://...loginToken=...` callback shape, validate the token, and
  never navigate the main window to an arbitrary URL from argv. Use
  `requestSingleInstanceLock()` and route `second-instance` argv; do not open a
  second app instance.

If external SSO is not a requirement, **remove** the registration. The current
in-app sign-in window already works; a half-implemented scheme is avoidable
attack surface.

### 5.4 Desktop entry, WM_CLASS, taskbar and launcher icons

Measured on the Phase-1 prototype under Xvfb with Electron 44.4.5:

```
WM_CLASS(STRING) = "plotina-lite-desktop", "plotina-lite-desktop"
_NET_WM_ICON(CARDINAL) =
```

Two concrete problems:

1. **WM_CLASS mismatch.** The prototype does not call `app.setDesktopName`, so
   Electron falls back to a slug of the app name (`plotina-lite-desktop`). The
   existing installer writes `plotina-lite.desktop` with
   `StartupWMClass=plotina-lite` (and the Tauri deb has `Plotina Lite
   Desktop.desktop`). The launcher/taskbar will not associate the window with
   the desktop file, and the icon/grouping is wrong. Electron 44 docs require
   `app.setDesktopName()` before `ready`, matching the installed `.desktop`
   filename, preferably a reverse-DNS ID such as `cc.plotina.chat`. Decide one
   identity and use it everywhere:
   - `app.setDesktopName('cc.plotina.chat')` before `whenReady`;
   - install `cc.plotina.chat.desktop` with
     `StartupWMClass=cc.plotina.chat`, `Icon=cc.plotina.chat`;
   - install hicolor icons `cc.plotina.chat.png` at 16..512;
   - set `app.setAppUserModelId('cc.plotina.chat')` on Windows so the shortcut
     AUMID matches.
   If you keep `plotina-lite`, then `plotina-lite.desktop` and
   `StartupWMClass=plotina-lite` must be the installed pair. Do not mix.
2. **Empty `_NET_WM_ICON`.** The prototype passes a 512×512 `assets/icon.png`
   as `BrowserWindow.icon`. Electron writes `_NET_WM_ICON` in one X request;
   512×512 exceeds the X protocol request limit (the measured element-desktop
   note: 256×256 needs 262,152 bytes vs a 262,140 limit). Cap the window icon at
   128×128 (`element-desktop/desktop/icon.ts:12-22`); the launcher/taskbar icon
   still comes from the hicolor theme. A 512 px icon in the package is fine for
   the launcher, but not for `BrowserWindow.icon`.

Also check Wayland: `app.setDesktopName` sets the XDG `app_id`; the `.desktop`
file must match or GNOME/KDE portals reject some APIs. Test both X11 and Wayland
if possible.

### 5.5 AppImage: FUSE, runtime, and cross-grade replacement

- Electron-builder AppImages are type-2 AppImages and need FUSE 2 to mount on
  systems without `libfuse2`/`libfuse2t64`. Provide the standard
  `--appimage-extract-and-run` instruction, or install `libfuse2`.
- The Tauri AppImage also needs FUSE. A user who currently runs the Tauri
  AppImage with `APPIMAGE_EXTRACT_AND_RUN=1` has no `$APPIMAGE`; the Tauri
  updater cannot replace the file (it falls back to the read-only mount path).
  Those users must replace the file manually.
- The Tauri plugin's AppImage install preserves the old file's permission bits;
  an Electron AppImage is executable after replacement. Verify the new image
  starts from the same path, including the `~/.local/bin/plotina-lite`
  wrapper used by `install-lite-appimage.sh`.
- `install-lite-appimage.sh` writes its own `.desktop` and copies icons from
  the AppImage. Update it for Electron's icon/desktop names, or the launcher
  will point at the old Tauri entry after a manual install.
- AppImage update after cross-grade: Electron's updater resolves
  `process.env.APPIMAGE` and swaps in place (`element-desktop/desktop/updater.ts:378-546`).
  If the directory is not writable, it saves the verified image to Downloads
  and tells the user; test that fallback.

### 5.6 deb/rpm dependencies and package identity

- The Tauri `.deb` in this repo is `Package: plotina-lite-desktop`,
  `Depends: libwebkit2gtk-4.1-0, libgtk-3-0` (measured from a built `.15`
  artifact; the `.17` build uses the same package name and its own
  `-plotina.<N>` revision). An Electron deb must use the **same package name**
  and a higher version to be an `apt` upgrade rather than a second package; set
  the package name to `plotina-lite-desktop` and use `5.0.0` (or `4.12.900`),
  which sorts above `4.12.8-plotina.17`.
- Electron's default deb dependencies are GTK3/NSS/GBM/ALSA/X11 libraries, not
  WebKitGTK. On Ubuntu 24.04 the `t64` transitions (`libasound2t64`,
  `libgtk-3-0t64`) can produce unsatisfied dependencies if the control file is
  generated with old names. Check `dpkg-deb -I` and install on clean Ubuntu
  22.04/24.04 and Fedora/openSUSE before release.
- If the package name changes, `apt` keeps both packages and both `.desktop`
  files; the menu shows two “Plotina Lite Desktop” entries. Same package name
  avoids this; otherwise add a `Conflicts/Replaces` or a post-install cleanup.
- The Tauri `.desktop` file is named `Plotina Lite Desktop.desktop` (spaces);
  electron-builder's default is a slug (`plotina-lite-desktop.desktop`). On
  upgrade, the old file may remain. Either keep the same filename or remove the
  old file explicitly in the package post-install.
- RPM: verify `Version` has no `-` (the Tauri build intentionally uses a numeric
  patch for this reason) and that the package name matches the old one if an
  in-place upgrade is desired.

### 5.7 Other packaging/runtime pitfalls

- **Single instance / port conflict**: `app.requestSingleInstanceLock()` only
  covers Electron. The old Tauri process can hold 44548. Add a preflight check,
  a clear error, and (for the installer) kill/remove the old app. Do not
  silently choose another port.
- **User data path**: pin it. The prototype's product name gives
  `~/.config/Plotina Lite Desktop`; if `app.setName`/`productName` changes
  later, the profile moves and users look logged out. Call `app.setPath`
  explicitly before `ready` if needed.
- **CSP**: the prototype's static server sets no Content-Security-Policy;
  Electron prints the insecure-CSP warning. Add a policy that still allows
  Cinny's wasm, blob workers, and Element Call iframe.
- **Server MIME/caching**: `.wasm` is `application/wasm` (good), but `sw.js`
  should be `no-cache`; `index.html`/`config.json` must not be immutable.
- **Sandbox/preload**: keep `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`. The token-migration preload should use a narrow
  synchronous IPC only on first run, then remove the migration file and stop
  exposing the channel.
- **Window state**: the prototype writes `window-state.json` in userData; if
  the old Tauri window state is in a different file, do not migrate it blindly
  (monitor bounds may be invalid). It already clamps to visible displays.
- **Protocol/SSO**: the current in-app SSO window uses `window.open` and
  `postMessage`; if the Electron shell switches to a custom scheme, retest the
  opener relationship. The prototype's `setWindowOpenHandler` allows only the
  app origin and sends other HTTP(S) popups to the OS browser; keep that.
- **Tray/notifications**: Phase 1 has no updater and optional tray. Notification
  permission is granted only to the app origin; test on Windows/Linux.
- **No auto-update in Phase 1**: the prototype has no updater; do not ship a
  `latest.yml` until the Electron updater is wired, or clients will have an
  inert `app-update.yml`.

---

## 6. Checklist

### Before the first Electron release

- [ ] Decide: manual reinstall or a one-off `.18` Tauri bridge. Record the
      decision and the support message.
- [ ] If manual: publish a clear “uninstall old app, install new app, log in
      again” note; keep the old profile for rollback.
- [ ] If automatic: build `.18` with the updater patch; set
      `plugins.updater.windows.installMode: "quiet"`; publish and test.
- [ ] Choose Electron app version > `4.12.818` (`5.0.0` recommended) and keep it
      monotonic.
- [ ] Pin `appId` (`cc.plotina.chat` or a deliberate alternative), `productName`
      (`Plotina Lite Desktop`), executable name (`plotina-lite`), `.desktop`
      filename, and WM_CLASS/desktopName to one set.
- [ ] Set `app.setDesktopName` before `ready`; install matching hicolor icons;
      cap `BrowserWindow.icon` at 128×128.
- [ ] Implement/verify first-run profile detection: Tauri profile exists, app
      data path, re-login vs settings import vs experimental Windows copy.
- [ ] Ensure the Electron app closes/kills the old Tauri process before binding
      44548; show a useful error if the port is busy.
- [ ] Add CSP, `no-cache` for `sw.js`/`index.html`, and path-traversal tests to
      the static server.
- [ ] Decide whether `cc.plotina.chat://` is registered; if yes, wire Linux
      `.desktop` MimeType, Windows `protocols`, and single-instance routing; if
      no, remove the registration.

### Build/signing

- [ ] Electron-builder config has `publish` owner `plotina-cc` / repo `clients`;
      CLI overrides confirmed in packed `app-update.yml`.
- [ ] Windows Authenticode signing configured; `publisherName` present in
      `app-update.yml`; `Get-AuthenticodeSignature` valid in CI.
- [ ] `latest.yml`, `latest-linux.yml`, NSIS `.exe.blockmap` produced and
      uploaded; artifact names match `files[].url`.
- [ ] Upgrade to electron-builder v27 signed manifests, or document the
      SHA-512/TLS-only risk and get sign-off.
- [ ] Transition `latest.json` signed with the Tauri key, both platforms,
      version > old, URLs on `https://plotina.cc/dl/`; validate with
      `updater_manifest.py`.
- [ ] Tamper test: one flipped byte in the artifact must fail verification and
      leave the old AppImage byte-identical.
- [ ] Tauri key backed up offline; access limited; plan to retire it after the
      transition.

### Release/QA

- [ ] Linux AppImage: install from clean user, update from `.18` with Electron
      payload, verify replacement and restart; test `--appimage-extract-and-run`
      fallback.
- [ ] Linux deb/rpm: install on clean Ubuntu 22.04/24.04 and Fedora; check
      dependencies, package name, `.desktop` filename, and icon.
- [ ] Windows NSIS: silent install, app-update.yml, launch; then cross-grade
      from Tauri with `/P` and `/S` args; assert old product cleanup or
      documented side-by-side.
- [ ] Windows MSI: document manual uninstall/reinstall; do not feed it NSIS.
- [ ] WM_CLASS/`_NET_WM_ICON`/desktop file verified with `xprop` on X11 and
      `app_id` on Wayland.
- [ ] Protocol handler cold start and second-instance token handoff tested.
- [ ] Feed freeze plan after migration; old Tauri shortcut cannot re-offer
      Electron indefinitely.

---

## Appendix A: reproducible probes

All probes were run on this Linux host; no product code was modified.

### A.1 Sign an Electron artifact with the Tauri key and validate the manifest

```bash
cd /home/hermes/.hermes/cache/scratch/minisign-test
cp /path/to/electron.AppImage Plotina-Lite-Desktop.AppImage
cp /path/to/electron-setup.exe Plotina-Lite-Desktop-setup.exe

TAURI_PRIVATE_KEY_PATH=~/.tauri/plotina-lite.key \
TAURI_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/plotina-lite.key.password)" \
  /path/to/tauri signer sign Plotina-Lite-Desktop.AppImage
TAURI_PRIVATE_KEY_PATH=~/.tauri/plotina-lite.key \
TAURI_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/plotina-lite.key.password)" \
  /path/to/tauri signer sign Plotina-Lite-Desktop-setup.exe

python3 cinny/scripts/updater_manifest.py build \
  --version 5.0.0 --notes 'Cross-grade test' \
  --platform linux-x86_64=Plotina-Lite-Desktop.AppImage.sig \
  --platform windows-x86_64=Plotina-Lite-Desktop-setup.exe.sig \
  --out latest-full.json
python3 cinny/scripts/updater_manifest.py validate --manifest latest-full.json
```

Observed: both platforms validated with key id `A8F0EF4E176BB29E`; a one-byte
flip made the independent verifier fail.

### A.2 Read the Tauri Linux localStorage

```bash
cp ~/.local/share/cc.plotina.chat/localstorage/http_localhost_44548.localstorage /tmp/ls.sqlite
python3 - <<'PY'
import sqlite3
con = sqlite3.connect('/tmp/ls.sqlite')
for key, value in con.execute('select key, value from ItemTable'):
    if isinstance(value, bytes):
        value = value.decode('utf-16-le')
    print(key, repr(value))
PY
```

The real profile showed `i18nextLng` and `after_login_redirect_url`; WebKitGTK
stores strings as UTF-16LE.

### A.3 Token injection prototype

Electron 44.4.5 has Node 24 and `node:sqlite`. The probe:

1. read `ItemTable` read-only with `DatabaseSync`;
2. decode UTF-16LE;
3. send the items over a synchronous IPC channel;
4. set them in a sandboxed preload at `http://localhost:44548`;
5. load the page.

Observed: `RESULT {"title":"syt_TESTTOKEN","token":"syt_TESTTOKEN","user":"@test:plotina.cc","hs":"https://plotina.cc"}`.
This proves the injection mechanism, not a healthy Matrix session (no
IndexedDB/crypto store).

### A.4 Electron profile layout

An Electron 44.4.5 app at `http://localhost:44548` that writes localStorage and
opens an IndexedDB database produced:

```
<userData>/Local Storage/leveldb/
<userData>/IndexedDB/http_localhost_44548.indexeddb.leveldb/
<userData>/Session Storage/
```

### A.5 WM_CLASS / icon observation

Running the Phase-1 prototype under Xvfb:

```
WM_CLASS(STRING) = "plotina-lite-desktop", "plotina-lite-desktop"
_NET_WM_ICON(CARDINAL) =
```

The empty `_NET_WM_ICON` is with a 512×512 `BrowserWindow.icon`; see
`element-desktop/desktop/icon.ts:12-22` for the 128 px fix.

### A.6 Custom scheme probe

A minimal Electron 44.4.5 app registered `plotina-test` and `cc.plotina.chat`
with `{standard:true, secure:true, supportFetchAPI:true, allowServiceWorkers:true}`
and served a page plus `/sw.js`. Both origins reported
`secure:true`, `localStorage` worked, `navigator.mediaDevices` existed; service
worker registration succeeded on retry but failed intermittently with:
`The Service Worker system has shutdown.` Do not rely on a custom scheme's
service worker without a packaged test and retry/fallback.

---

## Appendix B: source references

Paths under `cinny/` that are not in the `.17` tag — `updater_manifest.py`,
`build_config.py`, `desktop-patches/0003-plotina-updater-client-support.patch`,
the install-kind Rust module — are part of the pending `feat/lite-updater`
worktree, not `main` at the time of writing. `cinny/tests/qa_lite/minisign_check.py`
is from the separate QA worktree.

- `.17` config: `git show v4.12.8-plotina-lite-desktop.17:cinny/tauri.plotina.json`
  — `createUpdaterArtifacts: false`, `endpoints: []`.
- Pending updater config: `cinny/tauri.plotina.json` in the uncommitted
  `feat/lite-updater` worktree — `createUpdaterArtifacts: true`, pubkey,
  `https://plotina.cc/dl/lite/latest.json`.
- Updater manifest rules: `cinny/scripts/updater_manifest.py:20-57`.
- Version scheme: `cinny/scripts/build_config.py` (`4.12.818` for `.18`).
- Tauri signature verification: `tauri-plugin-updater-2.10.1/src/updater.rs:1453-1462`.
- Tauri Linux install: `updater.rs:976-1039`; Windows install/args:
  `updater.rs:787-865`; install modes: `src/config.rs:14-47`.
- Tauri NSIS identity: `tauri-bundler/.../nsis/installer.nsi`,
  tauri-cli-v2.7.1, lines 35-58 and 101-114 (`UNINSTKEY` uses `PRODUCTNAME`;
  `currentUser` install uses `$LOCALAPPDATA\${PRODUCTNAME}`).
- Pending install-kind assumption: `cinny/upstream/src-tauri/src/install_kind.rs:166-195`.
- Element updater: `element-desktop/desktop/updater.ts:1-40, 84-86, 176-224,
  245-300, 378-575`; security note `:43-61`.
- Element icon/X11 limit: `element-desktop/desktop/icon.ts:12-22`.
- Electron-builder NSIS GUID and install dir:
  `app-builder-lib/out/targets/nsis/NsisTarget.js:170-190`;
  `templates/nsis/multiUser.nsh:26-47`.
- Electron-builder workflow pattern: `.github/workflows/build-element-desktop.yml:210-300,
  337-365, 410-470`.
- Tauri app data path: `tauri-2.11.3/src/manager/webview.rs:528-549`;
  `path/desktop.rs:253-260`.
- Cinny session keys: `cinny/upstream/cinny/src/app/state/sessions.ts:32-64`;
  stores: `src/client/initMatrix.ts:14-36`.
- Phase-1 Electron prototype (untracked, parallel worktree):
  `/home/hermes/clients-lite-electron/cinny-electron/src/main.js`,
  `src/app-server.js`, `src/preload.js`.
