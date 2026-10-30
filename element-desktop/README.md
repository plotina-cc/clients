# Element Desktop for plotina.cc

Element Desktop is the Electron shell around Element Web. We ship it with our own
webapp inside, so calls get DeepFilterNet3 noise suppression and the default
homeserver is plotina.cc, without the user changing anything.

## Which upstream

`element-web` at `v1.12.32` (`UPSTREAM_TAG`), the same tag as our web image.

Since 1.12.14 the desktop shell lives in the element-web monorepo under
`apps/desktop`; `element-hq/element-desktop` was archived at v1.12.13 and cannot
build 1.12.32. One checkout gives us both halves at one version, and
`apps/desktop/package.json` carries the same 1.12.32.

The webapp in the asar is the official release build
`element-v1.12.32.tar.gz` (URL and SHA-256 in `webapp.lock.json`), not a rebuild:
it is built from the same tag as the `vectorim/element-web` image, so the desktop
and chat.plotina.cc run the same code. `WEBAPP_DIR` lets a build use an unpacked
`/app` from `plotina/element-web` instead.

## What our delta is

No upstream source is patched. Upstream supports exactly this: a `webapp`
directory (or `webapp.asar`) next to `apps/desktop`, packed by
`pnpm run asar-webapp` and loaded from the `vector://vector/webapp/` protocol.
The delta is applied to the webapp after it is unpacked:

- `apply-noise.py` copies `../noise/` into the webapp and adds
  `<script src="noise/logic.js"></script><script src="noise/boot.js" defer></script>`
  to `index.html` — the same two files the web image loads, the wrapper on
  `getUserMedia` plus the level slider in Settings → Voice and Video.
- `../element-web/config.json` becomes the webapp's `config.json` with
  `web_base_url` added (context-menu links point at chat.plotina.cc) and
  `sentry.dsn` filled from `SENTRY_DSN`; `update_base_url` is dropped, so the
  shell never asks Element for updates. Upstream's `apps/desktop` reads that same
  file: the main process calls `Sentry.init()` when `sentry.dsn` is present and
  the renderer's `initSentry()` runs from the config it receives over IPC, so
  both halves report to GlitchTip. A build without a usable DSN fails instead of
  shipping silent binaries.
- Script tags are **relative** on purpose: the custom protocol serves only paths
  below `/webapp/`, so the `/noise/...` used on the web would 404 here.
  `noise/boot.js` resolves its own directory at runtime
  (`document.currentScript`), which also keeps the file identical for every client.

```
UPSTREAM_TAG              element-web tag we build against
webapp.lock.json          release tarball URL + sha256 (tag must match UPSTREAM_TAG)
build.plotina.json        electron-builder variant: appId cc.plotina.element,
                          package name plotina-element, productName Plotina Element
apply-noise.py            webapp overlay + config.json
scripts/prepare-webapp.sh tarball -> overlay -> .build/webapp
scripts/build.sh          clone, install, asar, installers -> dist-stable/
```

## Building

```bash
SENTRY_DSN=... element-desktop/scripts/build.sh
```

`SENTRY_DSN` is the GlitchTip DSN (`https://<32 hex>@sentry.plotina.cc/relay/1`);
it overrides the value committed in `element-web/config.json`, and CI passes
the repository variable so a rotation needs no commit. The build fails if the
resulting config has no usable DSN, because a desktop that cannot report is not
shippable.

Linux produces `dist-stable/Plotina-Element.AppImage` and
`Plotina-Element.deb`; Windows (Git Bash) produces
`dist-stable/Plotina-Element-setup.exe` via NSIS. Needs node 24 with pnpm,
python3, git and curl; the upstream clone and the 53 MB tarball are cached in
`.build/`.

The same steps run in CI: `.github/workflows/build-element-desktop.yml` triggers
on a `v*-plotina.*` tag, builds one webapp and hands it to the Linux and Windows
packaging jobs, then attaches the stable names to the release. macOS is out of
the matrix: unsigned builds hit Gatekeeper, the arm64 runner only covers Apple
Silicon, and the microphone entitlement needs a Developer ID.

Path filters do not apply to tag pushes, so both this workflow and the Cinny one
match every `v*-plotina.*` tag; the `gate` job checks what the tagged commit
changed and skips the build when it was not ours.

## Updates

There is no auto-update and nothing to point at a feed:

- Linux has no updater in the shell at all;
- the Windows build is NSIS, not Squirrel, so `autoUpdater` finds no
  `Update.exe` and disables itself;
- `update_base_url` is absent from the baked config, which is the switch that
  starts the updater on the remaining platforms.

A new version is a new installer, installed over the old one. Profiles are
separate from upstream Element (`plotina-element` as the app name), so both can
be installed side by side.

## Assumptions that upstream can break

| Assumption | Where | What happens if it breaks |
|---|---|---|
| Desktop lives in `element-web/apps/desktop` with the `asar-webapp` script | `build.sh`, workflow | Clone/build fails loudly |
| Release asset `element-v<tag>.tar.gz` exists and matches the lock | `prepare-webapp.sh` | Fails on 404 or sha256 |
| `</head>` in the unpacked `index.html` | `apply-noise.py` | Fails loudly |
| `vector://` serves only `/webapp/` | script tags, `noise/boot.js` | Calls lose the denoiser (raw audio), console shows 404s |
| `noise/boot.js` still finds its own URL | `apply-noise.py` guard | Fails loudly |
| `element.io/release/build.json` keys used by our variant | `build.plotina.json` | electron-builder fails |

## Verifying a build by hand

- The packed config carries Sentry:
  `node -e 'console.log(JSON.parse(require("@electron/asar").extractFile("webapp.asar","config.json")).sentry)'`
  prints the relay DSN with `environment: "production"` (run in `apps/desktop`).
- Starting the app logs `Enabling Sentry with dsn=https://<key>@sentry.plotina.cc/relay/1 environment=production`
  from the main process; without that line Sentry never initialised.
- Settings → Voice and Video shows the noise slider (default 60).
- In a call, `window.__plotinaNoiseStats` in the devtools console counts
  `callRequests`/`processed`; `window.__plotinaNoise.isSupported()` is `true`.
- The app is called "Plotina Element" and logs into plotina.cc by default.
- `Help → About` shows 1.12.32; there is no update prompt.

## Licence

Element Web and Element Desktop are AGPL-3.0. We distribute modified binaries, so
the corresponding source is this repository plus the pinned upstream tag; keep
the upstream copyright notices. Third-party licences for the vendored denoiser
are in `../noise/vendor/`.
