# Cinny for plotina.cc

One directory per client, because the modification is the same for both
surfaces: the web app and the desktop build consume the shared wrapper in
`../noise/` (`logic.js`, `boot.js`, `vendor/` with DeepFilterNet3) plus the
source patches in `patches/` — `0009` compiles the Settings → General noise
block into the bundle as a React component. Only the delivery differs — the
web client is served as static files, the desktop build compiles the dist into
a Tauri binary.

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
apply-noise.py       copies noise/ into dist and inserts the tags into the call document
branding.py          applies Plotina icons, HTML metadata and manifest to the dist
tests/               unit tests for branding.py (python3 -m unittest discover -s cinny/tests)
tauri.plotina.json   build override: no beforeBuildCommand, updater disabled
noise.lock.json      URL and sha256 of the two model binaries (wasm and .tar.gz)
scripts/build.sh     local Linux build (AppImage + deb)
scripts/fetch-noise.py  downloads the model into noise/, verifying sha256
windows/             our NSIS installer: installer.nsi + build-installer.sh
```

## Cinny Web

Static files on the edge (`/srv/cinny`), built by
`.github/workflows/build-cinny-web.yml` and unpacked there unchanged: the
workflow takes the tag from `UPSTREAM_TAG`, applies the patches in `patches/`
(Sentry, branding, SSO handoff, the Updates page and the noise settings block),
embeds `noise/` (models fetched and verified
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

**Why the call frame is patched and the shell is not.** Cinny renders calls in
an iframe pointing at `public/element-call/index.html`; that iframe has its own
`window`, so wrapping `getUserMedia` in the parent page would never see the
call. The call frame gets `logic.js` + `boot.js` through `apply-noise.py`.
The parent needs no noise script at all: the Settings → General block is React
(`patches/0009`) and shares the `plotina.noise.*` localStorage keys with the
frame — a write there fires a `storage` event in the call, where boot.js
retunes the running processors.

Verifying: `https://cinny.plotina.cc/noise/logic.js` returns 200; Settings →
General shows the noise slider above Appearance with the default level 60
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
cp ../noise/logic.js ../noise/boot.js noise/
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

`patches/0008` adds the Settings → **Обновления** page
(`SettingsPages.UpdatesPage`, menu item with `Icons.Download`, component
`src/app/features/settings/updates/Updates.tsx`). It is the renderer half of
the Lite Desktop update channel and speaks only through the preload bridge
(`window.plotinaLite`: `appVersion()`, `updater.checkForUpdates()`,
`updater.onStatus`, `updater.channel.{get,set,returnToStable}`), so all dev
acknowledgement and downgrade policy stays in the main process. On Cinny Web
the bridge is absent and the page shows an explanatory notice. It replaces the
floating bottom-right update button that overlapped the composer.

`patches/0009` adds the noise settings block to Settings → **General**
(`src/app/features/settings/general/PlotinaNoise.tsx`, rendered above
Appearance): Cinny's own `SequenceCard`/`SettingTile`/`Box`/`Text` plus a
native range input and a native backend select, reading and writing the same
`plotina.noise.level` / `plotina.noise.backend` keys boot.js consumes. It
replaces the DOM block `noise/cinny-ui.js` used to inject with a
MutationObserver, anchor text search, colour sampling and hand-written CSS —
that file is deleted, and the shell no longer carries any noise `<script>`
tags.

**Why not point the app at our website.** Tauri can open an external URL, but
then the remote page needs IPC access — that is the CVE-2024-35222 class of
vulnerability. The web part is compiled into the app instead, and updates only
come from our own builds.

## Licence

Cinny and cinny-desktop are AGPL-3.0. We distribute modified binaries and serve
the web build over the network, so we must offer the corresponding source: this
public repository is that offer. Do not remove the upstream copyright notices.

## Build inputs

The desktop bundle embeds the shared `noise/` layer at build time, so the
default suppression level and the settings block come from whatever `noise/`
held when the tag was cut. The web build is served from the same files, which
is why the two must be rebuilt together after a change there.
