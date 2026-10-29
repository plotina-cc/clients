# Element Call for plotina.cc

Our own Element Call, served at `call.plotina.cc`, with the DeepFilterNet3 wrapper from
`../noise/` injected into it. One static bundle is meant to serve every client that can be
pointed at it: Element X (which has no native call code at v26.10.1 — it opens Element Call in a
WebView), and optionally Element Web and Cinny.

**Status: scaffold. No CI run yet, nothing deployed.** Everything below comes from the tagged
sources; the two live checks against plotina.cc carry their date.

## Pin

| | |
| :-- | :-- |
| Upstream | `element-hq/element-call` **v0.26.1** |
| Release tarball | `element-call-0.26.1.tar.gz`, sha256 `552e16f8…21e8f254`, pinned in `pins.env` |
| Why this tag | Element X v26.10.1 embeds `element-call-embedded:0.26.1`; Element Web v1.12.32 embeds `0.26.0`. The widget URL parameters and the MatrixRTC transport handshake are a contract between the client and the widget, so the server side is pinned to the version the clients were built against. |
| Not taken | v0.28.0 exists. It drops `matrix_rtc_session.wait_for_key_rotation_ms` and changes defaults; a bump has to be made together with the clients, not before them. |

## Build

```bash
element-call/build.sh                      # release mode, the default
element-call/build.sh --mode source        # clone the tag and run pnpm build:full
element-call/build.sh --help
```

`release` mode is the normal one: it downloads the upstream release tarball, checks it against the
sha256 in `pins.env`, injects the wrapper and adds `config.json`. No Node, no pnpm, no compiler — the
tarball is upstream's own `pnpm build:full` output for that tag, so there is nothing to reproduce.
`source` mode exists for the day we carry a change that cannot be expressed as a post-build edit; it
needs Node 24 and pnpm 11.21.0 and ~16 GB of RAM for the Vite build.

The script needs bash, `python3`, `curl` and GNU `sha256sum` on PATH — true on the CI runner and on
any Linux box; on macOS `brew install coreutils` and put them ahead of the BSD tools.

Output: `dist/plotina-element-call.tar.gz`, one top-level directory:

```
element-call-plotina/
├── index.html                 # upstream, plus two <script> tags after <head>
├── favicon.png
├── config.json                # ours (upstream ships none)
├── LICENSE-AGPL-3.0           # upstream ships none either
├── assets/…                   # hashed Vite output, referenced as /assets/…
└── noise/
    ├── logic.js  boot.js      # the shared wrapper
    ├── vendor/dfn.esm.js      # + its two licences
    └── dfn/v3/pkg/df_bg.wasm  # 16.4 MB, sha256 from pins.env
        dfn/v3/models/DeepFilterNet3_onnx.tar.gz   # 8.0 MB
```

The tar is written with `--sort=name --mtime=@0` on GNU tar, so a rebuild of the same inputs is
byte-identical and comparable with the published asset.

## Error reporting

`patches/0002-plotina-sentry.patch` initialises `@sentry/react` in `src/main.tsx`, before the first
render and before `config.json` is fetched, so a crash during startup is still reported. The DSN is
read from `VITE_SENTRY_DSN` at build time and the release from `VITE_SENTRY_RELEASE`; both are
optional, and an empty DSN turns reporting off without changing anything else. Nothing is traced
(`tracesSampleRate: 0`) and the environment is always `production`.

```
VITE_SENTRY_DSN=https://<key>@sentry.plotina.cc/1 \
VITE_SENTRY_RELEASE=element-call@<tag> \
  element-call/build.sh --mode source --maps-out dist/sourcemaps
```

`--maps-out` copies each source map and the script it describes to `dist/sourcemaps` and removes the
maps from the bundle, so the published tarball never ships the TypeScript source. With
`--sentry-cli /path/to/sentry-cli` the debug ids are injected first, which is what pairs an event
with its map. The workflow does the upload (`releases new`, then `sourcemaps upload --url-prefix
"~/assets" dist/sourcemaps/assets`) and skips it with a notice when `SENTRY_AUTH_TOKEN` is not set.
Source maps for `v0.26.1-plotina-call.10` are in the `web-clients` project; releases are listed under
`element-call@<tag>` in the GlitchTip UI.

## How the wrapper gets in

`inject-noise.py` inserts, immediately after `<head>` and ahead of Vite's `<script type="module">`:

```html
<script src="/noise/logic.js"></script><script src="/noise/boot.js"></script>
```

Synchronous on purpose. `boot.js` replaces `navigator.mediaDevices.getUserMedia`; the app bundle is
what calls it, and a deferred script would still be behind the module script in document order. Two
same-origin files of ~30 KB are not worth the race.

The paths are absolute (`/noise/…`), which is why this bundle must be served at the **root of its own
origin** and not under a subdirectory. `call.plotina.cc` is that origin.

## Configuration

`config.json` is fetched at runtime, so changing it needs no rebuild and no new release:

```json
{
  "default_server_config": { "m.homeserver": { "base_url": "https://plotina.cc", "server_name": "plotina.cc" } },
  "livekit": { "livekit_service_url": "https://plotina.cc/livekit/jwt" },
  "matrix_rtc_mode": "compatibility"
}
```

- `matrix_rtc_mode: compatibility` is what this Synapse does: legacy `/sfu/get` JWT plus the
  MSC4143 transports endpoint. `matrix_2_0` needs sticky events and the hashed-identity flow and is
  not configured on our server.
- The homeserver is the source of the SFU URL: Element Call asks the authenticated
  `/_matrix/client/unstable/org.matrix.msc4143/rtc/transports` endpoint first and only falls back to
  `livekit.livekit_service_url` (`RtcTransportAutoDiscovery.ts`). Verified 2026-10-28: the endpoint
  answers `401 M_MISSING_TOKEN` (it exists), and `/.well-known/matrix/client` already advertises
  `org.matrix.msc4143.rtc_foci` pointing at `https://plotina.cc/livekit/jwt`.
- When Element Call does fetch a token itself it posts to `{livekit_service_url}/sfu/get`
  (`src/livekit/openIDSFU.ts:214`), so the value is the lk-jwt base URL, without `/sfu/get`.
- `config.json` is looked up at `/config.json` when the pathname ends in `/room`, otherwise next to
  `index.html` (`src/config/Config.ts:48-57`). Both work with this layout.
- Analytics keys (`posthog`, `sentry`, `rageshake`) are deliberately absent: absent means the
  consent UI and the reporting are off.

## URL contract

| URL | What it renders |
| :-- | :-- |
| `https://call.plotina.cc/room#?roomId=…&widgetId=…` | the call (widget or standalone) |
| `https://call.plotina.cc/` | the home page — standalone mode, wants a login. Never point a client here. |
| `/login`, `/register` | their pages; every other path falls through to `*` → `RoomPage` |

The parameters live in the fragment (`#?…`), which is how matrix-rust-sdk builds the widget URL
(`new_virtual_element_call_widget`): it takes `element_call_url` verbatim, appends `#?<query>`, and
defaults `parent_url` to `element_call_url` when the host passes null. Element Call then only talks
to `new URL(parentUrl).origin` (`src/widget.ts:92-95`) — its own origin, in the WebView case, which
is exactly the trick Element X's message bridge relies on. For an iframe the host passes its own
origin, so Element Web and Cinny would be talking to `call.plotina.cc` from their own origins.

## Which clients can switch

### Element X Android v26.10.1 — yes, no fork

Calls go through `DefaultCallWidgetProvider`, which reads
`appPreferencesStore.getCustomElementCallBaseUrlFlow()` and falls back to the bundled asset URL
(`features/call/impl/…/utils/DefaultCallWidgetProvider.kt:22,44-45`). The value is a **developer
setting**: Settings → tap the version at the bottom seven times (`ShowDeveloperSettingsProvider`,
`DEVELOPER_SETTINGS_COUNTER = 7`) → Developer options → Element Call → base URL. The validator only
requires `http(s)` and a host (`AppDeveloperSettingsPresenter.kt:170-177`), so
`https://call.plotina.cc/room` is accepted. It is stored app-wide in `elementx_preferences`
(`elementCallBaseUrl`), i.e. per install, not per account.

To have it preconfigured in our own APK instead of by hand, one line in the fork we already build:

```diff
-        val baseUrl = customBaseUrl ?: EMBEDDED_CALL_WIDGET_BASE_URL
+        val baseUrl = customBaseUrl ?: "https://call.plotina.cc/room"
```

That is a default, not a replacement: the developer setting still overrides it. Nothing else in
Element X needs to change — the WebView bridge, the `window.controls` audio-device/PiP calls and the
permission grants are URL-agnostic.

### Element Web v1.12.32 — not through config.json any more

`element_call.url` **does not exist in 1.12.32**. The config schema has only `brand`,
`use_exclusively`, `disable` and `guest_spa_url` (`packages/shared-types/lib/config.json.d.ts:123`,
`docs/config.md` §6). Calls are rendered from the Element Call **bundled into the image**: webpack
copies `@element-hq/element-call-embedded@0.26.0` to `webapp/widgets/element-call/`
(`apps/web/webpack.config.ts:719`), and the widget URL is
`new URL("./widgets/element-call/", window.location.href)` unless
`SettingsStore.getValue("Developer.elementCallUrl")` overrides it
(`apps/web/src/models/Call.ts:880-895`). So:

1. **Per device, no patch:** Devtools → *Element Call URL* (`Developer.elementCallUrl`,
   `Settings.tsx:1552`; the field is in `DevtoolsDialog.tsx:133`). DEVICE level means localStorage,
   so it is one setting per browser profile, not a deployment.
2. **Replace the bundled widget:** drop our bundle into `/app/widgets/element-call/` in the overlay
   image. It must be built with `--base /widgets/element-call/` (the release tarball uses absolute
   `/assets/…`), and then Element Web calls Element Call on its own origin — no second domain, no
   cross-origin postMessage. `build.sh` has no `--base` switch yet, so this needs a second build
   flavour; real work, but the only "fleet" option that keeps the iframe model.
3. **Leave the URL alone and inject noise into the bundled widget:** one extra line in
   `element-web/Dockerfile` (`sed -i` on `/app/widgets/element-call/index.html` instead of
   `/app/index.html`) plus the existing `/app/noise` copy. This does not use `call.plotina.cc` at
   all, but it reaches the document that actually calls `getUserMedia`.

> Worth knowing: the current overlay patches `/app/index.html`, the app shell. Since 1.12 the call
> runs by default in the `/widgets/element-call/` iframe, which is a separate document with its own
> `window` — the shell's wrapper never sees the call's `getUserMedia`. (The one exception is the
> `feature_element_call_react` Labs flag, default `false`, which renders Element Call as an
> in-process React component inside the shell; that path would be covered by the current patch, but
> it is not the default and not what our users run.) Option 3 is the one-line fix for the iframe
> path, independent of this directory.

### Cinny v4.12.8 — needs a patch, and not a small one

`CallEmbed.getWidget` hardcodes the iframe URL to
`${BASE_URL}/public/element-call/index.html` (`src/app/plugins/call/CallEmbed.ts:116`) and puts the
parameters in `search`. Pointing it at us means changing that line **and** reworking
`CallControl`, which reaches into the iframe's DOM to find its own buttons
(`CallControl.ts:24,177` — `contentDocument.querySelector('[data-testid="incall_leave"]')` and
friends). Cross-origin, `contentDocument` is `null` and `contentWindow.document` throws, so the
control overlay would break at start. On top of that, Cinny's driver does not grant the MSC4143
transports capability (`getCallCapabilities`, `src/app/plugins/call/utils.ts`), so Element Call
would fall back to `livekit_service_url` from `config.json` — it should still connect, but that path
would be untested.

Recommendation: leave Cinny on its bundled Element Call 0.20.1 with the existing `noise/` injection.
The wrapper is the same code; only the delivery differs, and Cinny's iframe DOM coupling is not
worth a fork for that.

## Deploy

For whoever holds the edge (this repository cannot deploy itself):

```bash
# 1. fetch and verify the release asset
curl -fsSLO https://github.com/plotina-cc/clients/releases/download/<tag>/plotina-element-call.tar.gz
sha256sum plotina-element-call.tar.gz          # compare with the release notes

# 2. unpack next to the current one, then switch the symlink
sudo tar -xzf plotina-element-call.tar.gz -C /srv
sudo mv /srv/element-call-plotina /srv/element-call-<tag>
sudo ln -sfn /srv/element-call-<tag> /srv/element-call

# 3. edit /srv/element-call/config.json if the homeserver or SFU moved — no rebuild
```

Caddy, on `call.plotina.cc`:

```caddyfile
call.plotina.cc {
    root * /srv/element-call
    encode gzip

    # SPA: /room is the call, everything else falls back to the shell.
    try_files {path} /index.html
    file_server

    header {
        # Element Web and Cinny embed this in an iframe; Element X opens it top-level.
        Content-Security-Policy "frame-ancestors 'self' https://element.plotina.cc https://cinny.plotina.cc"
        Permissions-Policy "microphone=(self), camera=(self), display-capture=(self)"
        -X-Frame-Options
    }
    header /config.json Cache-Control "no-cache"
    header /noise/*.js Cache-Control "no-cache"
    header /noise/dfn/* Cache-Control "public, max-age=2592000"
    header /assets/* Cache-Control "public, max-age=31536000, immutable"
}
```

Notes that matter for the first deploy:

- **No redirects on this host.** `call.plotina.cc` must not 301 to another name or to a subpath:
  the widget origin is part of the postMessage contract, and a redirect changes it.
- **Do not add `X-Frame-Options: DENY` or a `frame-ancestors 'none'`** from a global header
  snippet. The embed must work from `element.plotina.cc` and `cinny.plotina.cc`.
- **CSP.** Element Call's own `index.html` contains inline `<script>` blocks, so a strict
  `script-src` without `'unsafe-inline'`/nonces breaks the app before our wrapper is even reached.
- **CORS on the token endpoint** is already fine: `https://plotina.cc/livekit/jwt/sfu/get` answers
  `access-control-allow-origin: *` (checked 2026-10-28). If that is ever narrowed to a list, add
  `https://call.plotina.cc`.
- **Compression.** `df_bg.wasm` is 16.4 MB and compresses to roughly 10 MB. `encode gzip` is enough
  for a one-off download; `gzip -9 -k` on the edge plus Caddy's `precompressed gzip` saves the CPU.

## What to check on the first real build and deploy

1. `bash -n element-call/build.sh`, `python3 -m py_compile element-call/inject-noise.py`, and the
   workflow YAML parse — the only checks possible without a build. The patch step itself was run
   against the real v0.26.1 `index.html` (tags land ahead of the module script, re-running is a
   no-op), and `pins.env`'s tarball sha256 was measured, not guessed.
2. In the workflow: the tarball unpacks, `index.html` carries both tags **before** the module script,
   `config.json` parses, `df_bg.wasm` is > 10 MB and the model > 7 MB (a truncated download is the
   classic failure; the sha256 check in `build.sh` is what actually catches it).
3. `https://call.plotina.cc/room` with no parameters: Element Call should render its error/lobby
   state, not the home page. If it shows the home page, the path is wrong or the SPA fallback is not
   in place.
4. In the browser console on that page: `window.__plotinaNoise.isSupported()` → `true`, and
   `window.__plotinaNoise.level` → `60`. During a call, `window.__plotinaNoiseStats` should go
   `callRequests: 1, processed: 1`.
5. The slider: Element Call keeps its noise-suppression toggle in the **Developer** settings tab; the
   wrapper looks for that row by its label ("Noise suppression" / "Подавление шума") and inserts
   itself after it. If the label moved, the slider disappears while the denoiser keeps running at
   the stored level — check `localStorage["plotina.noise.level"]`.
6. Element X: unlock developer settings (7 taps on the version), set
   `https://call.plotina.cc/room`, start a call, and confirm the WebView loads our host (logcat, or
   `chrome://inspect`). Then verify audio is actually denoised — the same room, A/B against the
   bundled widget.
7. One encrypted call with two participants, one of them on Element Web's bundled widget and one on
   `call.plotina.cc`: the media keys are exchanged over the widget API, the two builds only differ in
   where the JS came from, so a failure here is a MatrixRTC/version problem, not a noise problem.
8. Mute → unmute, screen share (screen-share audio always passes `noiseSuppression: false` and must
   stay unprocessed), and a second call after the first ends.

## Risks

- **E2EE is untouched, but the trust boundary grows.** The wrapper only processes PCM before it is
  handed to LiveKit; SFrame keys, IVs and SDP are none of its business. What does change is that the
  code handling media and media keys in the browser now comes from `call.plotina.cc` — one more
  origin that must stay ours, on TLS, with no third-party script. That is the same trust we already
  place in `element.plotina.cc`.
- **postMessage origin.** `new WidgetApi(widgetId, parentOrigin)` filters every incoming message by
  origin. If the host page's origin differs from the `parentUrl` in the URL (redirect, `www.`,
  trailing path, http→https), the widget silently ignores the client. Cross-origin iframes need no
  CORS, but they do need the iframe to be allowed by `frame-ancestors`.
- **Version drift.** The widget parameter contract lives in two places that move independently:
  matrix-rust-sdk's `element_call.rs` (which builds the URL) and Element Call's `UrlParams.ts` (which
  parses it). 0.26 → 0.28 already drops a config key. Bump the pin together with Element X and
  Element Web, and re-run the checks above.
- **The wrapper's trigger is a constraint shape.** `noise/boot.js` treats
  `getUserMedia({audio: {noiseSuppression: <boolean true>}})` as call audio. Element Call passes the
  boolean from its own setting (`ConnectionFactory.ts:179`), and screen-share audio passes `false`
  explicitly, so both sides agree today. If upstream moves capture into a worklet or switches to
  `{ideal: …}`, the wrapper stops matching without an error — `__plotinaNoiseStats.otherAudioRequests`
  is the tell.
- **No native call UI.** This keeps Element X on the WebView call path: no native call screen, no
  system PiP, no call-kit integration. That is the price of not touching the native audio path.

## Cost, against the native path

Estimates, not measurements — nothing in either directory has been through a build yet.

| | This directory | `../element-x/` (Rust/JNI) |
| :-- | :-- | :-- |
| Client patch | Element X: none (a setting), optionally one line for a default. Element Web: one line in the image, or nothing. | Kotlin + Rust shim, 3 patches, a published AAR, `-PelementCallLocalVersion` |
| Build cost | ~1 minute in CI: download, inject, tar. `source` mode is 10-20 min and rarely needed. | 60-90 min cold, 25-40 min warm; NDK, cargo-ndk, tract, R8 |
| Time to a working call | 0.5-1 day, most of it deployment and audio QA | 1.5-3 days plus keystore, plus audio QA |
| Call experience | WebView: no native UI, no PiP | Native call UI, PiP, but on a call stack upstream marks `isFinished = false` |
| Blast radius of a bad release | one static directory, roll back the symlink | every user reinstalls an APK |

The two are not alternatives for the same goal: the web path gets noise suppression to everyone on
the clients we already ship, without a fork of the audio stack; the native path is the only way to
also get native call UI. If both are ever shipped, they must not disagree about the denoiser level —
both read `plotina.noise.level` / the same model.

## Licence

AGPL-3.0 (see `../LICENSE`), matching Element Call. The bundle is the upstream release tarball plus
the files in this repository, so the source offer for what we serve is this repository plus the
pinned tag. The tarball ships no licence files of its own, so `build.sh` copies our `LICENSE` in as
`LICENSE-AGPL-3.0` — it is byte-identical to upstream's, verified at v0.26.1. `noise/vendor/` keeps
its own MIT/Apache-2.0 notices.
