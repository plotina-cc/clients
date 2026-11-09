# Element Web with Plotina noise suppression

Element Web (pinned upstream image) plus a small overlay that runs microphone
audio for **Element Call** through DeepFilterNet3 and adds a level slider to
Settings → Voice & Video.

Nothing in Element's own code is patched: the image contains the stock build
with a small Plotina overlay — the brand pass (`branding.py`, which rewrites
`index.html`, the error-view chunk, the two `theme-*-custom.css` sheets (the
`--timeline-text-color` contrast fix, see THEMES.md), the `config.json`
branding block and the theme logos) plus the noise overlay (a `/noise/`
directory and two `script` tags in `index.html`). `branding.py` also injects
the `/plotina-theme.js` bootstrap tag before the bundle loader so a fresh
dark-OS visitor lands on the dark Plotina custom theme (upstream custom
themes cannot follow `prefers-color-scheme` themselves). That keeps the
overlay cheap to rebase onto
a new upstream release: every brand assumption is pinned by
`tests/branding_test.py` and a Dockerfile assertion, so a moved marker fails
the build loudly instead of quietly serving Element branding. See "Bumping
upstream".

## Layout

```
config/element/
  Dockerfile              overlay image (pinned FROM; branding + noise)
  branding.py             brand pass over /app (index.html, error-view,
                          theme-*-custom.css, config, logos)
  config.json             Element Web runtime config, including local Plotina logo
                          and branding.welcome_background_url (/plotina-bg.png)
  manifest.json           Plotina PWA manifest
  plotina-theme.js        first-visit theme bootstrap: seeds mx_local_settings.theme
                          from prefers-color-scheme before the bundle loads
  plotina-dm-aliases.js   personal room names: room_id -> label map in account data
                          cc.plotina.room_aliases, applied over Room.calculateRoomName
                          (see SPIKE-dm-aliases.md; ships in both clients)
  SPIKE-dm-aliases.md     spike report: route, proof, gaps, cost to production
  spike-dm-aliases/       proof.mjs (Playwright), bundle-hooks.sh, logs, screenshots
  plotina-icon.svg        login-header logo used before/without config
  plotina-icon-192.png    apple-touch-icon target (branding/icons/png/green-192.png)
  plotina-bg.png          welcome background (branding/icons/png/green-256.png)
  plotina-512.png         PWA/OG image; also overwrites
                          themes/element/img/logos/element-app-logo.png
  noise/
    logic.js              pure decisions: what is call audio, level clamping, strings
    boot.js               browser wiring: getUserMedia wrapper + settings slider
    vendor/dfn.esm.js     vendored deepfilternet3-noise-filter 1.3.0 (Apache-2.0)
    vendor/dpdfnet.esm.js experimental DPDFNet backend (Apache-2.0)
  tests/
    branding_test.py      brand-pass unit tests (python3 -m unittest, fixture copies)
    theme_init.test.js    node tests for plotina-theme.js (run via branding_test.py)
    fixtures/             byte-exact upstream index.html/error-view.js/config.json
    unit.html run.sh      logic tests (headless Chromium)
    integration.html integration.sh   real audio path with a fake microphone
```

Model assets (`df_bg.wasm`, `DeepFilterNet3_onnx.tar.gz`, and the DPDFNet
binary set under `vendor/ort/` + `vendor/dpdfnet/`) are **not** in git: the
Dockerfile downloads them at build time and verifies their SHA-256 — the DFN3
pair with `wget` against the pins above, the DPDFNet pair by running the
repo-level `noise/scripts/fetch-dpdfnet.py` with `noise/dpdfnet.lock.json`.

## Error reporting (GlitchTip)

Element Web has Sentry support upstream: `matrix-react-sdk`'s `initSentry()`
reads a `sentry` object from `config.json` at startup and calls `Sentry.init()`.
The integration is configuration only — no client code, no extra SDK, nothing to
rebase. We point it at our GlitchTip:

```json
"sentry": {
    "dsn": "https://<key>@sentry.plotina.cc/relay/1",
    "environment": "production"
}
```

The DSN is public by design (every bundle carries it) and is also the
`SENTRY_DSN` repository variable; `scripts/render-config.py` writes it into the
published file, so a rotation needs no commit. Its path must stay `/relay/1`:
the public root of `sentry.plotina.cc` answers 403 and only `/relay/*` is
routed, so a DSN without that prefix parses but every envelope is refused.

What this gives, and what it does not:

- **Automatic capture: no.** Upstream initialises the SDK with
  `defaultIntegrations: false` and no `GlobalHandlers`, so uncaught errors and
  rejected promises are not reported on their own. Events come from rageshake
  submissions: the "report a problem" path calls
  `window.mxSendSentryReport(text, issueUrl, error)`. Do not add a second,
  global `Sentry.init` — it would replace the client upstream owns and lose the
  release and source-map pairing.
- **Release: `1.12.32`, not `element-web@1.12.32`.** `initSentry()` passes
  `process.env.VERSION`, which upstream bakes into the bundle
  (`release:"1.12.32"` in `bundles/<hash>/6312.js`), and `config.json` has no
  release key. `scripts/sourcemaps.py` reads that literal back and the publish
  workflow uploads the maps under it, so events and maps always agree. The
  `element-web@…` name would need a source build with `VERSION=` set (this
  overlay does not build Element Web) or a rewrite of the baked literal;
  neither is done here.
- **Source maps: wired, waiting on the relay.** The image already ships the
  maps next to the bundles (that is why `chat.plotina.cc` answers
  `/bundles/<hash>/bundle.js.map`). `scripts/sourcemaps.py` extracts them from
  the pinned image and `.github/workflows/publish-element-web.yml` uploads them
  to GlitchTip. `sentry-cli` refuses a server URL with a path, so the upload
  needs `/api/0/*` at the public root; today only `/relay/*` is routed, and the
  workflow keeps that step non-fatal until the relay change lands.

Deploying a DSN change is one file: copy the published
`element-web-config.json` to `/srv/plotina/element/config.json` on the host
(the file `plotina-infra` also keeps under `/opt/plotina-infra/config/element/`)
and reload the page. Element Web fetches the config at startup, so no image
rebuild. Note that `element-desktop` renders its webapp `config.json` from this
same file, substituting `SENTRY_DSN` when the variable is set, so a desktop
build reports under the same release and needs a rebuild to pick up a rotated
DSN.

The desktop shell reports under its own label, `Plotina-Desktop@<version>`
(`@sentry/electron` derives it from the app name and version), and sends
minidumps for native crashes, so the web source maps do not apply to those.

## Licence and source

The image is AGPL-3.0. The Dockerfile copies `LICENSE-AGPL-3.0` and `NOTICE`
into `/app`, so the served app has the licence text at `/LICENSE-AGPL-3.0` and
the copyright/modification notice at `/NOTICE`. `config.json` adds
an "Исходный код" link to the sign-in footer through
`branding.auth_footer_links`; it points at
<https://github.com/plotina-cc/clients>. The upstream tag plus this repository
is the source pair, with the exact rebuild steps in `../SOURCE.md`.

## Tests

```bash
./tests/run.sh           # logic unit tests, headless Chromium, no Docker
python3 -m unittest discover -s tests -p '*_test.py'   # branding.py pass tests
./tests/integration.sh   # builds nothing: uses plotina/element-web:1.12.32-noise1
                         # runs a fake mic through both paths and checks attenuation
```

Integration thresholds: call audio must drop below 0.5 of the raw level, level 0
must stay above 0.8. The fake signal is noise + tone, so it proves the pipeline
runs; it does not judge speech quality.

## Bumping upstream

```bash
scripts/bump-element.sh 1.13.0
```

The script resolves the new tag's digest, rewrites the `FROM` line, rebuilds,
runs both test suites, and prints the Dockerfile diff. Deploy only after both
suites are green. On a failure, read the "Assumptions" table: a moved label or a
changed `</head>` is a two-line fix, a changed constraint shape means looking at
Element Call again.

## Deploy and rollback

`stack/docker-compose.yml` references the built tag. Rollback is a one-line
revert to the pinned upstream image and `docker compose up -d element`; the
slider disappears, calls fall back to the browser's noise suppression.

Model assets are ~24 MB raw (wasm 16.4 MB, gzip 4.3 MB; model 8 MB). They are
cached for 30 days and warmed when the user opens the voice settings; the first
call before that pays the download once.
