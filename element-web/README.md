# Element Web with Plotina noise suppression

Element Web (pinned upstream image) plus a small overlay that runs microphone
audio for **Element Call** through DeepFilterNet3 and adds a level slider to
Settings → Voice & Video.

Nothing in Element's own code is patched: the image contains the stock build with
one extra `<script>` tag in `index.html` and a `/noise/` directory. That keeps the
overlay cheap to rebase onto a new upstream release — see "Bumping upstream".

## Layout

```
config/element/
  Dockerfile              overlay image (pinned FROM, one sed on index.html)
  config.json             Element Web config (unchanged by the overlay)
  noise/
    logic.js              pure decisions: what is call audio, level clamping, strings
    boot.js               browser wiring: getUserMedia wrapper + settings slider
    vendor/dfn.esm.js     vendored deepfilternet3-noise-filter 1.3.0 (Apache-2.0)
  tests/
    unit.html run.sh      logic tests (headless Chromium)
    integration.html integration.sh   real audio path with a fake microphone
```

Model assets (`df_bg.wasm`, `DeepFilterNet3_onnx.tar.gz`) are **not** in git: the
Dockerfile downloads them at build time and verifies their SHA-256.

## How it hooks in

1. `index.html` loads `/noise/logic.js` and `/noise/boot.js`.
2. `boot.js` wraps `navigator.mediaDevices.getUserMedia`.
3. Element Call (LiveKit) asks for audio with plain booleans —
   `{echoCancellation: true, noiseSuppression: true, autoGainControl: true}` —
   while Element Web's voice-message recorder asks with constraint objects
   (`{ideal: …}`). `logic.js` treats only the boolean form as a call.
4. For call audio the browser's own noise suppression is disabled, DFN3 runs as
   an AudioWorklet, and the cleaned track is handed back to the app.
5. Any failure returns the untouched stream: a broken denoiser must never cost a
   call.

The stock **Noise suppression** toggle remains the master switch: when the app
asks for `noiseSuppression: false`, the wrapper does nothing. The slider stores
`plotina.noise.level` in `localStorage`, default 60 (DFN attenuation limit, dB).

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

## Assumptions that upstream can break

| Assumption | Where | What happens if it breaks |
|---|---|---|
| `/app/index.html` contains `</head>` | Dockerfile sed | Build fails loudly (`grep` guard) |
| nginx template at `/etc/nginx/templates/default.conf.template` | Dockerfile | Build fails loudly |
| Element Call passes boolean audio constraints | `logic.js` | Denoise silently stops; browser NS still works |
| Settings has a visible "Подавление шума" / "Noise suppression" label | `boot.js` | Slider missing; default 60 still applies |
| `deepfilternet3-noise-filter` exposes `DeepFilterNet3Core` and asset paths `v3/…` | `boot.js`, Dockerfile | Processing fails → falls back to raw audio |
| The bundle contains exactly one `release:"<version>"` literal | `scripts/sourcemaps.py` | Publish fails loudly instead of uploading maps under a name events never report |

## Tests

```bash
./tests/run.sh           # logic unit tests, headless Chromium, no Docker
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
