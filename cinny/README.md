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

## Updates

`plugins.updater.endpoints` is empty and `createUpdaterArtifacts: false`: the
build never offers an upstream update. Once we run our own feed, the minisign
pubkey and a `latest.json` link from our releases go here.

A `v*-plotina.*` tag in this repository builds Linux and Windows and creates a
release with the artifacts attached. macOS is out of the matrix on purpose: an
unsigned build hits Gatekeeper, the arm64 runner only covers Apple Silicon, and
the microphone entitlement needs a Developer ID — revisit only if someone asks
and pays for the $99/year account.

## Licence

Cinny and cinny-desktop are AGPL-3.0. We distribute modified binaries and serve
the web build over the network, so we must offer the corresponding source: this
public repository is that offer. Do not remove the upstream copyright notices.
