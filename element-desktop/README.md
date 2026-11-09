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

No upstream *webapp* source is patched, with one deliberate exception in the
Electron shell: `desktop/updater.ts` replaces `apps/desktop/src/updater.ts`
at build time (see *Windows auto-update* below). Everything else rides on
supported seams: a `webapp` directory (or `webapp.asar`) next to
`apps/desktop`, packed by `pnpm run asar-webapp` and loaded from the
`vector://vector/webapp/` protocol. The delta is applied to the webapp after
it is unpacked:

- `apply-noise.py` copies `../noise/` into the webapp and adds
  `<script src="noise/logic.js"></script><script src="noise/boot.js" defer></script>`
  to `index.html` — the same two files the web image loads, the wrapper on
  `getUserMedia` plus the level slider in Settings → Voice and Video. The same
  pair is added to `widgets/element-call/index.html` (with `../../noise/...`),
  because Element Call asks for the microphone from that iframe; without it the
  desktop call uses Chromium's weaker built-in suppressor.
- `branding.py` turns the Element shell into the Plotina one: title,
  application-name and theme-color (#17795A) in `index.html`, our favicon and
  apple-touch-icon instead of the `vector-icons` links, a local `og:image`,
  the error-view logo swapped for `plotina-512.png`, `manifest.json` renamed,
  and the `mobile_guide/` (an install page for phones the desktop never shows)
  deleted. It then applies the shared web fixes from
  `../element-web/webapp_fixes.py` (see *Parity with Element Web* below).
  `apply-noise.py --brand` only sets the `brand` key of
  `config.json` (the in-app name); this is the browser-facing half.
- `../element-web/config.json` becomes the webapp's `config.json` with
  `web_base_url` added (context-menu links point at chat.plotina.cc),
  `sentry.dsn` filled from `SENTRY_DSN`, and `update_base_url` kept as the
  on-switch for our Windows updater (see *Windows auto-update* below — the
  feed itself comes from `resources/app-update.yml`). Upstream's `apps/desktop`
  reads that same
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
build.plotina.json        electron-builder variant: appId cc.plotina.desktop,
                          package name plotina-desktop, productName Plotina Desktop
                          (the publish block here is ignored by upstream's
                          electron-builder.ts; CI forces it with --config.*)
desktop/updater.ts        replaces apps/desktop/src/updater.ts: our Windows
                          auto-updater (GitHub releases + latest.yml + sha512);
                          also exports getUpdateFeedUrl(), which patched ipc.ts
                          answers with so the webapp shows its Settings ->
                          "Check for updates" button on Linux/AppImage (upstream's
                          Squirrel-only autoUpdater.getFeedURL() throws there)
desktop/icon.ts           replaces apps/desktop/src/icon.ts: getMainWindowIcon()
                          caps the Linux window icon at 128px, because Chromium
                          cannot serialize a 256px icon into one _NET_WM_ICON
                          XChangeProperty request (262,152 B > 262,140 B limit)
                          and leaves the property empty
desktop/patch-shell.py    wires both files into upstream electron-main.ts/ipc.ts;
                          CI greps the compiled lib/*.js for the patched symbols
build/icons/              16..512 hicolor PNGs (RGBA, brand green); the Linux
                          build passes --config.linux.icon=icons and
                          --config.linux.desktop.entry.Name="Plotina Desktop",
                          so deb + AppImage ship every icon size
apply-noise.py            webapp overlay + config.json
branding.py               webapp shell branding: title, icons, meta, error view,
                          plus the shared web fixes (../element-web/webapp_fixes.py)
scripts/prepare-webapp.sh tarball -> overlay -> branding -> .build/webapp
scripts/build.sh          clone, install, asar, installers -> dist-stable/
```

## Windows auto-update

Upstream's `src/updater.ts` drives Electron's built-in autoUpdater, which on
Windows is Squirrel: it needs the `Update.exe` that a `squirrel` installer
ships. We package `nsis`, so upstream's updater always bails out with
"Squirrel not found", and upstream does not depend on `electron-updater` at
all — the `resources/app-update.yml` that electron-builder packs is inert
unless something reads it. `desktop/updater.ts` is that something. It is
copied over `apps/desktop/src/updater.ts` before compiling (CI step "Apply
Plotina desktop sources", and scripts/build.sh).

How a build becomes updatable, end to end:

- The build passes `--config.publish.provider/owner/repo/releaseType` on the
  CLI. CLI dot-overrides beat both upstream's `electron-builder.ts` config and
  the github-publish inference from package.json `repository`
  (vector-im/element-web); that is why `build.plotina.json`'s own publish
  block never worked (upstream's config builder whitelists variant fields and
  drops it). Verified against electron-builder 26.16.1: NSIS, deb and AppImage
  all carry `owner: plotina-cc` / `repo: clients` without any post-build
  patching (post-patching is now forbidden: the AppImage used to be re-packed
  after the fact, which silently broke the sha512 that `latest-linux.yml`
  publishes for it).
- Tag builds derive a per-build app version from the tag
  (`v1.12.32-plotina-desktop.30` -> `VERSION=1.12.32-plotina.30`) so two
  Plotina builds at the same upstream base are distinguishable. It must be a
  semver prerelease: a 4-segment `1.12.32.30` gets mangled by electron-builder
  into `1.12.3-2.30` inside latest.yml.
- electron-builder emits `dist/latest.yml` (+ a separate `.exe.blockmap`;
  the AppImage blockmap is embedded inside the AppImage in v26, and
  `latest-linux.yml` carries both the AppImage and the deb); the workflow
  stages them **unrenamed** and uploads them as release assets, because
  latest.yml references the installer by filename. Artifact names embed the
  version as plain text — a `${version}` macro does not survive nx's
  argument re-quoting (double quotes -> the shell expands it to empty; run
  #41 built `Plotina-Desktop-.AppImage`). After fix-deb-branding re-packs
  the deb, the workflow refreshes the deb's sha512/size inside
  latest-linux.yml so the published metadata stays truthful.
- The updater polls `api.github.com/repos/<owner>/<repo>/releases` (from
  app-update.yml), fetches `latest.yml` from the newest releases that carry
  one, compares numeric version tokens with `app.getVersion()`, downloads the
  installer, verifies its sha512, and runs it with `/S --updated --force-run`
  — `--force-run` is required for a *silent* NSIS install to relaunch the app
  (electron-builder 26.16.1's `installSection.nsh` starts the app after a
  silent install only with that flag; `/S --updated` alone installs and quits,
  which is how "Restart to update" became "turn off" on Windows). On Linux the
  same trap exists in another form: the AppImage is swapped in place and the
  relaunch goes through a detached wait-for-exit helper, because spawning the
  new image while the old process still holds the single-instance lock makes it
  print `Other instance detected: exiting` and die — the old app quits next and
  nothing is left running. Both orderings are pinned by
  `desktop/tests/update-restart.test.mjs`. Renderer
  IPC channels (`check_updates`, `install_update`, `update-downloaded`) are
  unchanged, so the webapp Settings UI keeps working.
- The `windows smoke` job silently installs the built setup.exe on a Windows
  runner, asserts the installed `resources/app-update.yml` names
  plotina-cc/clients, checks `Plotina-Desktop.exe` exists, launches the app,
  proves the process survives, and prints the installed version. The release
  job needs it.

Security trade-off (also commented in desktop/updater.ts): nothing is signed.
Authenticode verification is skipped **explicitly** by our updater, not by
accident. Note that electron-updater v6 (bundled with electron-builder
26.16.1) skips verification silently whenever app-update.yml has no
publisherName, while electron-updater v7 / electron-builder v27 *fail closed*
without a way to bake `verifyUpdateCodeSignature: false` through the 26.16.1
publish schema — another reason to own the updater code. Update authenticity
therefore rests on TLS to GitHub plus the release's sha512: whoever can write
to plotina-cc/clients releases can ship any binary that installs silently.
Users also see SmartScreen prompts (first run and updates) until the
installer is code-signed.

## Parity with Element Web

**Rule: every fix we ship in the Element Web image must also ship in Element
Desktop.** The shared fixes live in `../element-web/webapp_fixes.py` — one
module, consumed by both branding scripts (the PARITY RULE comment at its top
states the same):

- the `--timeline-text-color` -> `var(--cpd-color-text-primary)` fallback in
  both `bundles/*/theme-*-custom.css` sheets (light text on light background
  for dark-OS visitors), aborting if a sheet is missing or the 133-use count
  drops;
- the `plotina-modal-a11y` style block keeping the device-verification dialog
  inside the viewport, injected into `index.html` exactly once and never with
  a `.mx_AuthPage_modal` margin override (stock margins pin the auth footer
  to the viewport bottom);
- `plotina-theme.js`, the first-visit theme bootstrap. The file lives in
  `element-web/` for both clients: the web image COPYs it into `/app` and
  loads it with an absolute src; `branding.py` copies it from
  `../element-web` into the webapp root and references it **relatively**,
  because the shell serves the webapp from `vector://vector/webapp/` — the
  same rule as the noise tags;
- the missing `ru` verification strings merged into `i18n/ru.*.json`, only
  where absent;
- `plotina-dm-aliases.js`, the account-data alias overlay for personal room
  names (`SPIKE-dm-aliases.md`): same payload in both trees, tagged once in
  `index.html`, absolute src on the web and relative here.

The guards are `tests/test_webapp_fixes.py` (it feeds identical CSS/HTML
through both entry points and asserts byte-identical fix output) and the
parity greps in the `==> verify` step of `scripts/prepare-webapp.sh`, which
mirror the checks the web Dockerfile runs after its brand pass. When you add
a fix, put it in `webapp_fixes.py`, wire it into both branding scripts and
extend that test — never fork a fix into one client.

## Building

```bash
SENTRY_DSN=... element-desktop/scripts/build.sh
```

`SENTRY_DSN` is the GlitchTip DSN (`https://<32 hex>@sentry.plotina.cc/relay/1`);
it overrides the value committed in `element-web/config.json`, and CI passes
the repository variable so a rotation needs no commit. The build fails if the
resulting config has no usable DSN, because a desktop that cannot report is not
shippable.

Linux produces `dist-stable/Plotina-Desktop.AppImage` and
`Plotina-Desktop.deb`; Windows (Git Bash) produces
`dist-stable/Plotina-Desktop-setup.exe` via NSIS. Needs node 24 with pnpm,
python3, git and curl; the upstream clone and the 53 MB tarball are cached in
`.build/`.

### Installing on Linux

The installer is self-contained and, on Debian/Ubuntu with usable sudo,
subscribes the system to the signed Plotina apt repo and installs
`plotina-desktop` from it — so new builds arrive with the regular
`apt-get update && apt-get upgrade` instead of a one-off downloaded `.deb`:

```bash
curl -fsSL https://plotina.cc/dl/Plotina-Desktop-install.sh | bash
```

That step writes the key to `/usr/share/keyrings/plotina.gpg` (fetched to a
temp file, sanity-checked, then installed atomically) and the source line

```
deb [signed-by=/usr/share/keyrings/plotina.gpg] https://plotina.cc/apt ./
```

to `/etc/apt/sources.list.d/plotina.list` — exactly as documented in
<https://plotina.cc/apt/README.md>. Existing keyring/list files are left
untouched; `--deb` forces this path. If it is not possible (non-Debian, no
sudo, refused password, apt or network failure), the installer falls back to
the per-user AppImage below, and `--appimage` forces that. A positional `.deb`
path/URL and `PLOTINA_DEB_URL` are deprecated escape hatches: they install
that exact file via apt/dpkg without subscribing the machine to the repo.

To install the newest **dev-channel** build instead of stable, run the same
script with `--dev`:

```bash
curl -fsSL https://plotina.cc/dl/Plotina-Desktop-install.sh | bash -s -- --dev
```

It fetches `https://plotina.cc/dl/dev/desktop/latest-linux-dev.yml`, takes the
first `files:` entry, downloads that AppImage and verifies **both** its sha512
(base64 as published, or hex) and its size before installing it through the
usual per-user AppImage path (binary, `.desktop`, hicolor icons). Nothing is
installed when verification fails — there is no silent fallback to stable —
and the dev path never touches apt or GitHub. `--dev` cannot be combined with
`--deb`, a positional file or `PLOTINA_APPIMAGE_URL`; `PLOTINA_DEV_YAML_URL`
overrides the metadata URL (tests).

An AppImage does not register its `.desktop` file, so the browser keeps sending
the SSO callback (`io.element.desktop`) to an installed upstream Element. Run
the installer as the desktop user:

```bash
element-desktop/scripts/install-appimage.sh ~/Downloads/Plotina-Desktop.AppImage
```

It puts the image in `~/.local/bin/plotina-desktop`, installs the icon and
desktop entry, and makes `io.element.desktop`, `element` and
`cc.plotina.element` point at it. The apt-repo `.deb` installs the same
desktop entry system-wide; if an upstream Element is already the default
handler, choose Plotina Desktop once in the browser's protocol prompt.

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

A new version is a new installer, installed over the old one — except apt-repo
installs (`plotina-desktop` from `https://plotina.cc/apt`), which track
releases through `apt-get update && apt-get upgrade` like any other package.
Profiles are separate from upstream Element (`plotina-desktop` as the app
name), so both can be installed side by side.

## Verifying a build by hand

- The packed config carries Sentry:
  `node -e 'console.log(JSON.parse(require("@electron/asar").extractFile("webapp.asar","config.json")).sentry)'`
  prints the relay DSN with `environment: "production"` (run in `apps/desktop`).
- Starting the app logs `Enabling Sentry with dsn=https://<key>@sentry.plotina.cc/relay/1 environment=production`
  from the main process; without that line Sentry never initialised.
- Settings → Voice and Video shows the noise slider (default 60).
- In a call, `window.__plotinaNoiseStats` in the devtools console counts
  `callRequests`/`processed`; `window.__plotinaNoise.isSupported()` is `true`.
- The app is called "Plotina Desktop" and logs into plotina.cc by default.
- `Help → About` shows 1.12.32; there is no update prompt.

## Licence

Element Web and Element Desktop are AGPL-3.0. We distribute modified binaries, so
the corresponding source is this repository plus the pinned upstream tag; keep
the upstream copyright notices. `prepare-webapp.sh` copies `../LICENSE` and
`../NOTICE` into the webapp as `LICENSE-AGPL-3.0` and `NOTICE`, so they travel
inside `webapp.asar`, and the sign-in footer carries the same "Исходный код" link
as the web client. The exact tag and rebuild steps are in `../SOURCE.md`.
Third-party licences for the vendored denoiser are in `../noise/vendor/`.
