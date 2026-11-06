# Cinny for plotina.cc

One directory per client, because the modification is the same for both
surfaces: the web app and the desktop build consume the shared wrapper in
`../noise/` (`logic.js`, `boot.js`, `cinny-ui.js`, `vendor/` with DeepFilterNet3).
Only the delivery differs — the web client is served as static files, the desktop
build compiles the dist into a Tauri binary.

No source fork is needed: Cinny is taken at a pinned tag, the **built web dist**
is patched before packaging, and the installers are built with our own config.

## Source and licence

The web app and the desktop build are Cinny `v4.12.8` plus `patches/`,
`apply-noise.py` and `branding.py`. The source pair — upstream tag plus this
repository — is in `../SOURCE.md`. Patch `0002-plotina-source-link.patch` adds
the "Исходный код" link to the auth footer and to Settings → About; both point
at <https://github.com/plotina-cc/clients>. `apply-noise.py` copies
`../LICENSE` and `../NOTICE` into the dist as `LICENSE-AGPL-3.0` and `NOTICE`.
`branding.py` owns the browser shell: icons, HTML metadata and the web app
manifest, plus one pinned bundle default — fresh visitors get "follow the
system theme" (`useSystemTheme`), which renders Dark on a dark OS and Light
otherwise. The guard in `branding.py` rewrites `useSystemTheme:!1` back on
and aborts the build if the settings default is missing from the bundle.

## What is here

```
config.json          default homeserver (plotina.cc), no featured communities
UPSTREAM_TAG         the cinny-desktop tag we build against
apply-noise.py       copies noise/ into dist and inserts the tags into two documents
branding.py          applies Plotina icons, HTML metadata and manifest to the dist
tests/               unit tests for branding.py (python3 -m unittest discover -s cinny/tests)
tauri.plotina.json   build override: no beforeBuildCommand, updater endpoint + pubkey
noise.lock.json      URL and sha256 of the two model binaries (wasm and .tar.gz)
scripts/build.sh     local Linux build (AppImage + deb), signed for the updater
scripts/build_config.py     stamps the app version and the Tauri build config
scripts/updater_manifest.py builds/validates latest.json for the update feed
scripts/fetch-noise.py  downloads the model into noise/, verifying sha256
windows/             our NSIS installer: installer.nsi + build-installer.sh
```

## Cinny Web

Static files on the edge (`/srv/cinny`), built by
`.github/workflows/build-cinny-web.yml` and unpacked there unchanged: the
workflow takes the tag from `UPSTREAM_TAG`, applies the patches in `patches/`
(Sentry and the source link), embeds `noise/` (models fetched and verified
against `noise.lock.json`) and uploads `plotina-lite-web.tar.gz` with
`build-info.json` next to it (release, upstream tag, the repository commit and
the Cinny commit, run).

```bash
sha256sum -c plotina-lite-web.tar.gz.sha256
sudo mkdir -p /srv/cinny.new && sudo tar -xzf plotina-lite-web.tar.gz -C /srv/cinny.new
sudo chown -R bob3r:bob3r /srv/cinny.new
sudo sh -c 'mv /srv/cinny /srv/cinny.bak-$(date +%Y%m%d-%H%M%S) && mv /srv/cinny.new /srv/cinny'
```

Caddy reads the directory per request and needs no reload; the previous tree
stays as `/srv/cinny.bak-<timestamp>` and rolling back is renaming the two back.
Cache headers are the part Caddy does own: `/noise/dfn/*` for 30 days,
`/noise/*.js` as `no-cache`, and `index.html` as `no-cache` so a new shell with
new asset hashes is picked up.

**Why two documents.** Cinny renders calls in an iframe pointing at
`public/element-call/index.html`; that iframe has its own `window`, so wrapping
`getUserMedia` in the parent page would never see the call. The parent only needs
the settings UI.

Verifying: `https://cinny.plotina.cc/noise/logic.js` returns 200; Settings →
General shows the noise slider at the top with the default level 60
(`localStorage: plotina.noise.level`); inside a call, in the iframe,
`window.__plotinaNoise.isSupported()` is `true` and `window.__plotinaNoiseStats`
counts `callRequests`, `otherAudioRequests`, `processed` and `failed` — that is
how an upstream change in the constraint shape shows up.

## Error reporting

Upstream Cinny has no Sentry support of its own: no `@sentry` dependency, no
`sentry` key in `config.json`, nothing in the Tauri shell. The integration is
therefore a patch — `patches/0001-plotina-sentry.patch` adds
`src/plotina/sentry.ts`, calls it from `src/index.tsx` before the first render,
and switches Vite to hidden source maps. `scripts/build.sh` and the CI workflow
apply that same patch and both fail loudly if a future upstream tag moves
`src/index.tsx` or the `build` block of `vite.config.js`.

The DSN comes from `VITE_SENTRY_DSN` and the release from
`VITE_SENTRY_RELEASE`, both read at build time. They are optional: an empty DSN
turns reporting off and changes nothing else, which is what `npm start` and a
plain fork get. Only errors are sent — no tracing, no PII, and no breadcrumbs or
HTTP context, because a Matrix client's console output and URLs carry room, user
and event identifiers.

```bash
VITE_SENTRY_DSN="https://<key>@sentry.plotina.cc/relay/1" \
VITE_SENTRY_RELEASE="cinny@4.12.8" \
  scripts/build.sh
```

The release is `cinny@<version>` — `cinny@4.12.8` for upstream tag v4.12.8 —
and a tag of this repository is used as is (`cinny@v4.12.8-plotina-lite-desktop.4`),
which is the string the desktop build reports. `build.sh` falls back to
`cinny@<upstream tag>-local` on a checkout that is not at a tag. Events land in
the `web-clients` project with environment `production` and the tag
`client: cinny`. The web bundle on the edge must be built with the same
`VITE_SENTRY_RELEASE` as the maps, otherwise its events will not match them —
that is why the web build takes the release from `UPSTREAM_TAG` and never from
a branch name.

`scripts/sentry-sourcemaps.py` copies the app bundle's maps — everything under
`dist/assets` plus the root service worker — and the scripts they describe to
`$WORK/sourcemaps`, then removes the maps from `dist`, so neither the
installers nor `/srv/cinny` ship the TypeScript source. `dist/public` is left
alone: it holds packages we do not build (the embedded Element Call app, the
pdf.js worker) and their symbols belong to whoever builds them. CI injects
debug ids with sentry-cli and uploads that copy:

```bash
sentry-cli releases new "$release"
sentry-cli sourcemaps upload --release "$release" --url-prefix "~" "$maps"
```

`https://sentry.plotina.cc/api/0/*` is a token-gated proxy in the relay
(`Authorization: Bearer` from `/etc/plotina-sentry-relay/api-token`), so the
upload runs in CI with `SENTRY_AUTH_TOKEN` and a rejection is a real failure,
not the old 403. `build-cinny-web.yml` uploads the maps for `cinny@4.12.8` and
the artifact records the debug ids, which is what pairs an event with its map;
the release and the tag `client: cinny` are visible in every event.

Do **not** also inject a shell-level Sentry script (such as a vendored
`/noise/vendor/sentry-global.js`) into `index.html`: the bundle reports for
itself, and a second `Sentry.init` would replace this client and lose the
release and the source-map pairing.

## Cinny Desktop

```bash
git clone --recurse-submodules --depth 1 --branch "$(cat UPSTREAM_TAG)" \
  https://github.com/cinnyapp/cinny-desktop.git upstream
cd upstream && npm ci
cd cinny && npm ci && npm run build && cd ..

mkdir -p noise/vendor
cp ../noise/logic.js ../noise/boot.js ../noise/cinny-ui.js noise/
cp -a ../noise/vendor/. noise/vendor/
python3 scripts/fetch-noise.py
cp config.json upstream/config.json
python3 apply-noise.py --dist upstream/cinny/dist --noise noise
python3 branding.py --dist upstream/cinny/dist --brand "Plotina Lite Desktop"
npm run tauri -- build --config "$PWD/tauri.plotina.json"
```

Artifacts land in `upstream/src-tauri/target/release/bundle/{appimage,deb}/`.
Windows is cross-built (`cargo-xwin`, `--no-bundle`) and wrapped by
`windows/installer.nsi` through `makensis`; the comments inside those files list
the details. CI does the same natively on windows-latest.

### Sign-in (SSO) stays inside the app

Both Matrix sign-in paths open a *new window* and expect the answer to come back
to the window that opened it:

- the login page's **Continue with SSO** hands `/login/sso/redirect?...redirectUrl=<app origin>/login/...`
  to the browser and waits to be called back with `?loginToken=`;
- the UIA stage (`SSOStage.tsx`) calls `window.open(getFallbackAuthUrl(...))` and waits
  for `postMessage('authDone')` from the homeserver's completion page — Synapse's
  `auth_success.html` really does `window.opener.postMessage("authDone", "*")`.

With the upstream shell (`on_new_window` → `open_url` + `NewWindowResponse::Deny`)
both paths break the same way: `window.open` returns `null`, the dialog never
leaves "Continue with SSO", and the identity provider answers a *system browser*
that has no `window.opener` and no session in the app.

`desktop-patches/0002` keeps Matrix sign-in URLs in the app: `on_new_window` opens
them in a child webview built with `.window_features(features)`, which on GTK makes
the child a *related view* of the caller. WebKit then preserves the real opener
link, so `window.open` returns a live window object, `postMessage` from the
sign-in page reaches the app, and the `loginToken` callback lands on the app's own
origin (`http://localhost:<port>`, served by tauri-plugin-localhost). Every other
URL still goes to the system browser through `tauri-plugin-opener`. The child
window is deliberately absent from `capabilities/*.json` — only `main` is listed —
so a remote sign-in page gets no IPC access (the CVE-2024-35222 class).

`patches/0007` closes the loop for the login page. The callback arrives in the
child window, and a login token can be spent only once, so that window posts
`{type: 'plotina:sso:login-token', loginToken}` to its opener — restricted to its
own origin — and the main window runs `m.login.token` itself. In the browser build
the login page is never opened as a popup, `window.opener` is null there, neither
branch runs, and the web flow is unchanged.

**Why not point the app at our website.** Tauri can open an external URL, but
then the remote page needs IPC access — that is the CVE-2024-35222 class of
vulnerability. The web part is compiled into the app instead, and updates only
come from our own builds.

### Windows: NSIS updates itself, MSI does not

Two Windows installers ship from the same binary and they are not
interchangeable. **NSIS (`Plotina-Lite-Desktop-setup.exe`) is the auto-updating
installer** — the Tauri updater downloads the new setup.exe and runs it. **MSI
is a manual-install artifact only**, by decision, not because the plugin cannot
do it (tauri-plugin-updater will happily run `msiexec /i` for a
`windows-x86_64-msi` feed entry):

* the feed carries **one signed artifact per platform**, and those are exactly
  the stable `/dl` aliases users already download;
* the plugin resolves `<os>-<arch>-<installer>` and then falls back to the bare
  `<os>-<arch>` — so as soon as the bare Windows key is an NSIS setup.exe, an MSI
  install that asks the feed gets an NSIS installer run over a Windows Installer
  product: two uninstall entries and an MSI database that no longer matches the
  files on disk;
* elevating for every update is an msiexec/UAC conversation we do not want to
  force on a chat client mid-meeting.

So:

* `latest.json` never contains an MSI (or `.deb`/`.rpm`) URL —
  `updater_manifest.py` refuses to build such a manifest;
* the MSI is still published (`Plotina-Lite-Desktop.msi` in the release and on
  the edge) for people who need a package for GPO/SCCM;
* the client detects which kind it is running (`src-tauri/src/install_kind.rs`:
  the NSIS uninstaller file next to the exe and the `cc.plotina.chat` uninstall
  key versus a `WindowsInstaller=1` entry) and, for an MSI, **never calls the
  feed at all** — it shows «Автообновление недоступно для MSI-установки. Скачайте
  новый MSI и установите вручную.» with a link to
  `https://plotina.cc/dl/Plotina-Lite-Desktop.msi`. A deb/rpm install gets the
  same treatment pointing at the `.deb`. No evidence either way is treated as
  manual, never as "try the download".
* if MSI installs should ever update themselves, the honest change is to build
  and sign the `.msi` as its own updater artifact and publish a
  `windows-x86_64-msi` key beside the bare one — not to let the bare key serve
  them NSIS.

## Updater

Plotina Lite Desktop updates itself from **our** builds only. Nothing about the
feed is upstream's: `cinny/tauri.plotina.json` overrides the pubkey, the
endpoints and the artifact policy.

```
endpoints               https://plotina.cc/dl/lite/latest.json     (https only)
bundle.createUpdaterArtifacts   true
plugins.updater.pubkey  minisign public key 9EB26B174EEFF0A8
```

**Signing key.** Generated with `npm run tauri -- signer generate -w
~/.tauri/plotina-lite.key`. Private key `~/.tauri/plotina-lite.key` (0600,
password-protected; the password is in `~/.tauri/plotina-lite.key.password`,
0600) — **back this up off the machine**: losing either half means no existing
install can ever accept a new update, and there is no way to rotate it inside a
released binary. The same two values are GitHub secrets
`TAURI_SIGNING_PRIVATE_KEY` (the file *content*) and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, set with
`gh secret set TAURI_SIGNING_PRIVATE_KEY --repo plotina-cc/clients < ~/.tauri/plotina-lite.key`.
The public key is not a secret: it is committed in the overlay and pinned as the
workflow's `UPDATER_PUBKEY` so a build can prove config and signing key agree.

**Version stamping.** Upstream pins `version` to the Cinny tag (4.12.8), so
without a change every Plotina build reports the same version, and the updater
— which compares semver — could never tell .18 from .19 (it would either offer
nothing or offer the same update forever after installing it).
`scripts/build_config.py` stamps `<major>.<minor>.<patch*100 + build>` from the
release tag: `v4.12.8-plotina-lite-desktop.18` → app version `4.12.818`. The
counter rides in the numeric patch on purpose: a semver prerelease
(`4.12.8-plotina-lite-desktop.18`) is legal for the updater but illegal for the
installers — `-` cannot appear in an RPM `Version` and it splits the Debian
version into upstream + revision. `scripts/build_config.py check` also fails the
build if the overlay ever loses the pubkey, the endpoint or the artifact flag.

**Artifacts.** With `createUpdaterArtifacts: true` Tauri signs the bundle
*itself* — `*.AppImage` + `*.AppImage.sig`, `*-setup.exe` + `*-setup.exe.sig`.
That is the point: the bytes behind the stable `/dl` aliases are exactly the
signed bytes, so no second `.AppImage.tar.gz` copy has to live on the edge and
manual download and auto-update are the same file. (`"v1Compatible"`, which
upstream's own config still uses, signs a *different* file — the workflow
detects and rejects it.)

**Manifest.** The `updater-manifest` job of `build-cinny-desktop.yml` takes both
`.sig` files, runs `scripts/updater_manifest.py` and publishes the result as the
release asset **`update-lite-desktop.json`**. The edge mirrors that asset to
`/srv/dl/lite/latest.json` — the URL the clients actually read — only after it
has proved that the two artifacts the manifest points at are present in
`/srv/dl`, that their size and SHA-256 equal what GitHub reports for the same
release assets, and that every URL is `https://plotina.cc/dl/...` (see
`infra/scripts/publish-lite-updater-manifest.py`). A manifest that fails any
check is not installed: the previous one keeps serving.

**Verification in CI.** `cargo test --release --test updater_signature` runs the
same `minisign-verify` code path the plugin uses at runtime against the freshly
built artifact and the committed pubkey, and fails if a tampered byte would
still verify. The test skips quietly when no bundle was built.

**Local builds.** `scripts/build.sh` picks the key up from `~/.tauri` and stamps
the version from `git describe --tags`. For a throwaway bundle with no signing
key, `NO_UPDATER=1 scripts/build.sh` produces an unsigned build and prints a
reminder that it must not be published.

**In the app.** Settings → «Проверить обновления» (desktop only — the row is not
rendered in the browser build) shows: checking, «Обновлений нет», the available
version with the release notes and size, download progress, install + relaunch,
the manual states above, and readable errors. Upstream's startup auto-prompt is
removed by `desktop-patches/0004`: an update is always an explicit user act, and
the shell refuses to start a download for an install it cannot move.

### What survives a move to Electron

The updater work is layered on purpose, because the Tauri shell is the part most
likely to be replaced (WebKitGTK has no WebRTC, which is why Lite Desktop is
being re-evaluated). The split:

**Reusable as-is, independent of the shell**

* **The feed contract** — one static JSON at
  `https://plotina.cc/dl/lite/latest.json`, https only, holding `version`,
  `notes`, `pub_date` and one entry per platform with `url` + `signature`. Any
  shell can consume it; nothing in it is Tauri-specific except the consumer.
* **The artifact strategy** — exactly one signed artifact per platform, served
  from the stable `/dl` alias that users already download, so a manual download
  and an update payload are the same bytes. No per-release URLs anywhere, so a
  pruned release cannot 404 an installed client.
* **The version scheme** — `<major>.<minor>.<upstream patch*100 + build>`
  (`scripts/build_config.py`). Every updater in existence compares versions;
  electron-builder's `electron-updater` does it with semver too. A constant
  upstream version is an app that can never tell two builds apart, which is the
  trap this scheme exists to avoid, not a Tauri quirk.
* **The host-side publisher** — `infra/scripts/publish-lite-updater-manifest.py`
  validates the schema, pins the URLs to our host, proves the artifacts on disk
  match the GitHub asset size + sha256 before publishing, refuses to downgrade a
  feed and installs atomically. It only needs a `latest.json`-shaped file; if
  Electron ships `latest-linux.yml`/`latest.yml` instead, the same checks (pins,
  digest cross-check, atomic install, no-downgrade) are what a second publisher
  should do.
* **The key-handling policy** — a minisign (ed25519) key pair whose private half
  lives only in the GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (+ password) and in
  `~/.tauri/plotina-lite.key` (0600, backed up off-machine), whose public half is
  committed in the repo and pinned in the workflow. `tauri signer sign` is a thin
  wrapper over minisign; the same key and `.sig` files stay verifiable with
  `minisign -V`/`rsign` outside Tauri. What does *not* carry over: Electron's
  built-in updater on Linux/Windows verifies OS code signatures, not a detached
  minisign signature, so an Electron port either keeps a small custom verifier or
  accepts that the `.sig` role is taken over by Authenticode/notarization.
* **The CI shape** — two platform build jobs that sign, one `updater-manifest`
  job that assembles the feed from both `.sig` files, one release job that ships
  the manifest beside the installers. The same pipeline fits electron-builder,
  which also produces per-platform update metadata as a final step.
* **The UI states and the install-kind gate** — checking / up-to-date /
  available / downloading / installed / manual(MSI|deb-rpm) / error, and the rule
  that an install kind which cannot be moved is told so instead of being given a
  payload. In Electron the detection maps almost one-to-one:
  `process.env.APPIMAGE` for AppImage, `process.env.PORTABLE_EXECUTABLE_DIR` for
  the portable exe, the same NSIS-uninstaller-file / `WindowsInstaller=1`
  registry split for NSIS vs MSI.

**Tauri-specific, to be rewritten**

* `cinny/tauri.plotina.json` (`plugins.updater.pubkey`/`endpoints`,
  `bundle.createUpdaterArtifacts`), the `updater` Cargo feature, the capability
  entry `updater:default`, and the `plotina_install_kind` command.
* `src-tauri/src/install_kind.rs`, `tests/updater_signature.rs` (they call
  `minisign_verify` and the tauri-plugin-updater verification order) and
  `cinny/scripts/build_config.py` only insofar as it emits a *Tauri* config; its
  version function is reusable.
* The `updater-manifest` job's `Update-lite-desktop.json` names and the `.sig`
  format: `tauri build` writes `<artifact>.sig` as ONE base64 line wrapping the
  minisign document, and `latest.json`'s `signature` must carry that wrapped
  text verbatim. Electron's `latest-linux.yml` uses `sha512` + `size` + a
  `path`/`url` pair instead, and Windows `latest.yml` the same — a different
  schema, so the manifest builder is per-shell even though the policy is shared.
* On Linux, Tauri v2 with `createUpdaterArtifacts: true` signs the **raw
  AppImage** (`myapp.AppImage.sig`); the `.AppImage.tar.gz` form only exists in
  the legacy `"v1Compatible"` mode. Keep that in mind when reading older notes:
  the updater artifact and the manual download are the same file here.
* The AppImage replacement itself (the plugin renames the running AppImage into
  a temp dir on the same mount, writes the new bytes, restores permissions) and
  the Windows flow (NSIS `setup.exe /UPDATE`, MSI via `msiexec`) are shell
  behaviour, not feed behaviour.


## Licence

Cinny and cinny-desktop are AGPL-3.0. We distribute modified binaries and serve
the web build over the network, so we must offer the corresponding source: this
public repository is that offer. Do not remove the upstream copyright notices.

## Build inputs

The desktop bundle embeds the shared `noise/` layer at build time, so the
default suppression level and the settings block come from whatever `noise/`
held when the tag was cut. The web build is served from the same files, which
is why the two must be rebuilt together after a change there.
