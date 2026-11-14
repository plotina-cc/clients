# Element Web with Plotina noise suppression

Element Web (pinned upstream image) plus a small overlay that runs microphone
audio for **Element Call** through DeepFilterNet3 and adds a level slider to
Settings → Voice & Video.

Nothing in Element's own code is patched: the image contains the stock build
with a small Plotina overlay — the brand pass (`branding.py`, which rewrites
`index.html`, the error-view chunk, the two `theme-*-custom.css` sheets (the
legacy-token block, see THEME-TOKENS.md), the `config.json`
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
  Dockerfile              overlay image (pinned FROM; branding + noise + our
                          Element Call)
  element-call.lock.json  our Element Call (tag + URL + sha256); byte copy of
                          ../element-desktop/element-call.lock.json
  branding.py             brand pass over /app (index.html, error-view,
                          theme-*-custom.css, config, logos)
  config.json             Element Web runtime config, including local Plotina logo
                          and branding.welcome_background_url (/plotina-bg.png)
  manifest.json           Plotina PWA manifest
  scripts/
    element-call-widget.py      adapter: installs/verifies our Element Call at
                                /app/widgets/element-call (Web URL prefix)
    element-call-widget-core.py the swap + checks; byte copy of
                                ../element-desktop/scripts/element-call-widget.py
    build-image.sh              assembles the docker context (noise/ included)
    smoke-image.sh              serves the built image, checks brand, noise, EC
  plotina-theme.js        theme bootstrap: seeds mx_local_settings.theme from
                          prefers-color-scheme before the bundle loads, and
                          migrates theme ids saved before the Mint rename
  plotina-dm-aliases.js   personal contact names: mxid -> name map in account data
                          cc.plotina.contact_names, applied over Room.calculateRoomName
                          and to the person's RoomMember (so the name also shows in
                          group rooms); see SPIKE-dm-aliases.md and
                          FIX-dm-aliases-v12.md; ships in both clients
  SPIKE-dm-aliases.md     spike report: route, proof, gaps, cost to production
  FIX-dm-aliases-v12.md   post-QA fix: v12 opaque room ids, DM-only, empty reset
  spike-dm-aliases/       proof.mjs (Playwright), bundle-hooks.sh, logs, screenshots;
                          v12/ and v11/ hold the post-QA fix evidence
  plotina-icon.svg        login-header logo used before/without config
  plotina-icon-192.png    apple-touch-icon target (branding/icons/png/green-192.png)
  plotina-bg.png          welcome background (branding/icons/png/green-256.png)
  plotina-512.png         PWA/OG image; also overwrites
                          themes/element/img/logos/element-app-logo.png and
                          vector-icons/1024.png — the logo this client
                          registers as its OIDC logo_uri, which is what the
                          homeserver's auth service (MAS) draws next to the
                          session
  noise/
    logic.js              pure decisions: what is call audio, level clamping, strings
    boot.js               browser wiring: getUserMedia wrapper + settings slider
    vendor/dfn.esm.js     vendored deepfilternet3-noise-filter 1.3.0 (Apache-2.0)
    vendor/dpdfnet.esm.js experimental DPDFNet backend (Apache-2.0)
  tests/
    branding_test.py      brand-pass unit tests (python3 -m unittest, fixture copies)
    test_theme_custom_css_vars.py
                          no bare var(--x) in the generated theme-*-custom.css
                          without a definition; skips loudly when no built
                          webapp is around (PLOTINA_WEBAPP_ROOT / _STRICT)
    theme_init.test.js    node tests for plotina-theme.js (run via branding_test.py)
    fixtures/             byte-exact upstream index.html/error-view.js/config.json
    fixtures/theme-css/   trimmed shipped sheets: before (broken) / after (fixed)
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

## Personal contact names

`plotina-dm-aliases.js` gives every account personal names for the people it
talks to: a pencil in the open DM's header opens "Личное имя", and the name
lives in account data `cc.plotina.contact_names` as `{"<mxid>": "<name>"}`.
One key per PERSON, so two DMs with the same person show one name, and the name
they carry in a group room's member list and on their messages is the same one.
Only the signed-in account sees it; the room's own name and state stay
untouched (nothing writes a room name event or `m.room.member`), so the other
participant and other clients keep seeing the real names. `SPIKE-dm-aliases.md`
documents the route (`Room.calculateRoomName` wrapped through
`window.mxMatrixClientPeg`); `FIX-dm-aliases-v12.md` records the post-QA fixes
below.

- **Both room-id shapes.** Room versions up to 11 use `!localpart:server`;
  version 12 (Synapse's default since 1.162) uses an opaque `!<base64url>`
  with no server part. The overlay treats any `!` id without whitespace or a
  slash as a room id and decides what a room is from the room data
  (`client.getRoom`, `m.direct`, joined members) — never from the id's shape.
- **Rooms are not renamed, people are.** The pencil appears only for a DM,
  defined as a room the account's `m.direct` lists or a room with exactly two
  joined members. Setting a name on a group room is refused with a visible
  message. A group keeps its own name; so does a DM the user named explicitly
  with `m.room.name` — that title is the room's, and the person inside it still
  shows their personal name in the member list and on their messages.
- **Refusals are visible.** An invalid id or a non-DM room rejects with a coded
  `Error` (`invalid_room_id`, `unknown_room`, `not_direct`) and a banner, in
  addition to the message inside the dialog. Nothing fails silently.
- **Reset.** "Сбросить" drops the key from the map; every write is sanitised,
  so removing the last name stores `{}` and no entry ever holds an empty
  value. The account-data event itself stays behind as `{}`: matrix-js-sdk 44
  implements `deleteAccountData(type)` as `setAccountData(type, {})` and Matrix
  gives clients no way to remove account data.
- **The old room-keyed event is not read and not migrated.**
  `cc.plotina.room_aliases` stays in account data and is ignored as junk (the
  owner asked for a clean cut), so names set before the change are dropped.
- **Known seams** (unchanged from the spike): the browser tab title follows on
  the next room switch, not instantly; a room upgrade does not migrate the
  name; other clients and server-side push/email know nothing about it.

```bash
# pure logic: both id shapes, the DM rule, group member names, the empty reset
node tests/contact_names.test.js plotina-dm-aliases.js
# end to end on a real homeserver (v12: run it against Synapse >= 1.162 and
# pass --expect-opaque 1 --group <id>)
node spike-dm-aliases/proof-contact-names.mjs --base http://127.0.0.1:8071 \
  --homeserver http://127.0.0.1:18009 --owner alice:... --other bob:... \
  --room '!opaqueRoomId' --group '!groupRoomId' --expect-opaque 1 --out /tmp/shots
```

## Publish (CI)

`build-element-web.yml` builds this image on every pull request and on every
push to `main`, and smoke-tests the result (`scripts/smoke-image.sh`); those runs
never touch the registry. Publishing is a separate job behind the `ghcr-publish`
environment, so it happens only after a reviewer approves the run:

```
ghcr.io/plotina-cc/element-web:sha-<commit>     every publish, immutable
ghcr.io/plotina-cc/element-web:<release tag>    when a v*-plotina-web.* tag is pushed
ghcr.io/plotina-cc/element-web:latest           only when a dispatch asks for it
```

```bash
gh workflow run build-element-web.yml --ref main -f publish=true
```

The run stops at "Waiting for review"; approve it there and the digest
(`sha256:...`) lands in the run summary and on the package page. A release tag
(`v1.12.32-plotina-web.1`) asks for the same publish and holds at the same gate.

Pin the deploy to the digest, never to `latest`. CI does not deploy: the image is
served from golova, which pulls the digest by hand. If the package stays private,
the host needs a `read:packages` login; making it public (org → Packages →
element-web → visibility) removes that step.

## Element Call: our widget, not the upstream one

The pinned upstream image ships a stock Element Call at
`/app/widgets/element-call/`: none of our patches (`element-call/patches/`), so
a web user gets no per-person volume memory (0004) and no hide-this-stream
control (0005). The image replaces that widget wholesale, the same way Element
Desktop does.

- **What replaces it.** The archive `.github/workflows/build-element-call.yml`
  publishes (`plotina-element-call.tar.gz`), pinned by tag + sha256 in
  `element-web/element-call.lock.json` — a byte copy of
  `../element-desktop/element-call.lock.json`, so both clients ship the same
  Element Call and neither can re-pin alone. The Dockerfile downloads it at
  build time, verifies the digest and installs it at `widgets/element-call`.
- **Where it is served.** Element Web serves `/app` from the site root and its
  bundle opens `./widgets/element-call/` (`bundles/<hash>/6312.js`), so the
  widget lives at `/widgets/element-call/` and every root-absolute `/assets/…`
  URL in the archive is rebased onto that path. Desktop serves the webapp from
  `vector://vector/webapp/` and rebases onto `/webapp/widgets/element-call`
  instead; that prefix is the only difference, so the swap itself is one
  implementation — `scripts/element-call-widget.py` is an adapter over
  `scripts/element-call-widget-core.py`, a byte copy of
  `../element-desktop/scripts/element-call-widget.py` guarded by a drift test.
- **Noise layer is not duplicated.** `/app/noise/` already carries
  `plotina-dfn.js`, and the widget's index loads it through `../../noise/` —
  which *is* `/noise/` under the site root. The archive's own 24 MB `noise/`
  tree is dropped at install; a second copy would initialize the denoiser
  twice. The level control is Element Call's own (Settings → Audio since .17),
  so the floating capsule script `plotina-panel.js` is gone: the widget's index
  must not ask for it, the image layer asserts the file is absent, and
  `scripts/check-build-context.py` (run by the unit tests) refuses a `COPY` of a
  file the `noise/` overlay no longer carries.
- **The build fails if ours did not land.** The widget layer runs the same
  `--check` the desktop build runs (bundle markers, the Russian label for the
  paused-stream tile, the Plotina markers, no root-absolute asset URL, no
  widget-local `noise/`), then greps the final bytes for
  `cc.plotina.voice_volumes`, `setSubscribed` and `video_tile.stream_paused`,
  requires `video_tile.hide_stream` to be **absent** (it is the superseded
  submenu) and prints the counts. `scripts/smoke-image.sh` re-checks the same
  markers over HTTP on the running container, so a publish cannot ship a widget
  without them.

```bash
# the swap against an unpacked /app, exactly as the Dockerfile runs it
python3 scripts/element-call-widget.py --lock ../element-desktop/element-call.lock.json \
  --work /tmp/ec --webapp /app --url-prefix /widgets/element-call
python3 scripts/element-call-widget.py --check --webapp /app --url-prefix /widgets/element-call

# what the image carries, straight from the bundle
docker cp "$(docker create IMAGE)":/app/widgets/element-call/assets/index-*.js /tmp/ec.js
grep -o cc.plotina.voice_volumes /tmp/ec.js | wc -l   # > 0
grep -o setSubscribed /tmp/ec.js | wc -l              # > 0
```

`tests/test_element_call_widget.py` pins the whole contract. Its negative
control is the upstream layout itself (the stock widget at `./assets/index-…js`
with none of our markers): the check must reject it, exit non-zero, and pass
only after the swap.

## Deploy and rollback

`stack/docker-compose.yml` references the built tag. Rollback is a one-line
revert to the pinned upstream image and `docker compose up -d element`; the
slider disappears, calls fall back to the browser's noise suppression.

Model assets are ~24 MB raw (wasm 16.4 MB, gzip 4.3 MB; model 8 MB). They are
cached for 30 days and warmed when the user opens the voice settings; the first
call before that pays the download once.
