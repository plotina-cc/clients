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

## Assumptions that upstream can break

| Assumption | Where | What happens if it breaks |
|---|---|---|
| `/app/index.html` contains `</head>` | Dockerfile sed | Build fails loudly (`grep` guard) |
| nginx template at `/etc/nginx/templates/default.conf.template` | Dockerfile | Build fails loudly |
| Element Call passes boolean audio constraints | `logic.js` | Denoise silently stops; browser NS still works |
| Settings has a visible "Подавление шума" / "Noise suppression" label | `boot.js` | Slider missing; default 60 still applies |
| `deepfilternet3-noise-filter` exposes `DeepFilterNet3Core` and asset paths `v3/…` | `boot.js`, Dockerfile | Processing fails → falls back to raw audio |

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
