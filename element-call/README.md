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
├── NOTICE                     # copyright and modification notice
├── assets/…                   # hashed Vite output, referenced as /assets/…
└── noise/
    ├── logic.js  boot.js      # the shared wrapper
    ├── source-link.js         # "Исходный код" in the sign-in footer
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
`element-call@<tag>` in the GlitchTip UI. Do **not** also add a `sentry` block to `config.json`:
upstream's initializer would then call `Sentry.init` a second time, with `tracesSampleRate: 1`, and
replace the client this module set up.

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

## Licence

AGPL-3.0 (see `../LICENSE`), matching Element Call. The bundle is the upstream release tarball plus
the files in this repository, so the source offer for what we serve is this repository plus the
pinned tag. The tarball ships no licence files of its own, so `build.sh` copies our `LICENSE` in as
`LICENSE-AGPL-3.0` — it is byte-identical to upstream's, verified at v0.26.1. `noise/vendor/` keeps
its own MIT/Apache-2.0 notices.

Element Call v0.26.1 has no configurable site footer. The unauthenticated view renders the only
`<footer>`; `source-link.js` is copied into `/noise/` and injected into `index.html`, and appends
"Исходный код" to that footer. The call and lobby views have no `<footer>` (their controls use
`data-testid="footer-container"`), so the link does not appear over the call UI. The source pair is
also named in this README, the release notes and `../SOURCE.md`.
