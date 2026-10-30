# Cinny for plotina.cc

One directory per client, because the modification is the same for both
surfaces: the web app and the desktop build consume the shared wrapper in
`../noise/` (`logic.js`, `boot.js`, `cinny-ui.js`, `vendor/` with DeepFilterNet3).
Only the delivery differs — the web client is served as static files, the desktop
build compiles the dist into a Tauri binary.

No source fork is needed: Cinny is taken at a pinned tag, the **built web dist**
is patched before packaging, and the installers are built with our own config.

## What is here

```
config.json          default homeserver (plotina.cc), no featured communities
UPSTREAM_TAG         the cinny-desktop tag we build against
apply-noise.py       copies noise/ into dist and inserts the tags into two documents
tauri.plotina.json   build override: no beforeBuildCommand, updater disabled
noise.lock.json      URL and sha256 of the two model binaries (wasm and .tar.gz)
scripts/build.sh     local Linux build (AppImage + deb)
scripts/fetch-noise.py  downloads the model into noise/, verifying sha256
windows/             our NSIS installer: installer.nsi + build-installer.sh
```

## Cinny Web

Static files on the edge (`/srv/cinny`), no build step.

1. Copy `../noise/` to `/srv/cinny/noise` so `/noise/logic.js` resolves on the
   same origin.
2. Insert the tags into two documents:
   - `index.html` — the app shell, gets
     `<script src="/noise/logic.js"></script><script src="/noise/cinny-ui.js" defer></script>`
     which renders the level slider in Settings → General;
   - `public/element-call/index.html` — the embedded Element Call page, the only
     document that actually calls `getUserMedia`, gets
     `<script src="/noise/logic.js"></script><script src="/noise/boot.js" defer></script>`.
3. Cache headers on the edge: `/noise/dfn/*` for 30 days, `/noise/*.js` as
   `no-cache`, so a fix reaches browsers without a hard reload.

Edits are idempotent: the marker is checked before inserting, and each patched
document keeps a `.bak-plotina` copy.

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
VITE_SENTRY_DSN="https://<key>@sentry.plotina.cc/1" \
VITE_SENTRY_RELEASE="cinny@v4.12.8-plotina-cinny.4" \
  scripts/build.sh
```

The release is `cinny@<version+tag>` (`cinny@v4.12.8-plotina-cinny.4`);
`build.sh` takes the checked-out tag and falls back to
`cinny@<upstream tag>-local`. Events land in the `web-clients` project with
environment `production` and the tag `client: cinny`. The web bundle on the edge
must be built with the same `VITE_SENTRY_RELEASE` as the tag, otherwise its
events will not match the uploaded maps.

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

The upload currently answers 403: `https://sentry.plotina.cc` exposes only
`/relay/1`, and `/api/0/*` has to be proxied by the relay (separate change), so
the workflow step is non-fatal. Events themselves already reach GlitchTip
through the relay.

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
npm run tauri -- build --config "$PWD/tauri.plotina.json"
```

Artifacts land in `upstream/src-tauri/target/release/bundle/{appimage,deb}/`.
Windows is cross-built (`cargo-xwin`, `--no-bundle`) and wrapped by
`windows/installer.nsi` through `makensis`; the comments inside those files list
the details. CI does the same natively on windows-latest.

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
