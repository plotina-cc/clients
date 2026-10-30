# What the Plotina clients are built from

Each client is an upstream release plus the patch layer in this repository. The
patch layer is AGPL-3.0 (see `LICENSE`). Upstream versions are pinned in the
files named in the tables.

## Clients

| Project | What we take | License | Upstream |
| --- | --- | --- | --- |
| Element Web | `v1.12.32` web client (`element-web/Dockerfile`) | AGPL-3.0-or-later | [element-hq/element-web](https://github.com/element-hq/element-web) |
| Element Desktop | `v1.12.32`, the `apps/desktop` Electron shell (`element-desktop/UPSTREAM_TAG`) | AGPL-3.0-or-later | [element-hq/element-web](https://github.com/element-hq/element-web) |
| Element Call | `v0.26.1` web app, also bundled in Element X (`element-call/pins.env`) | AGPL-3.0-or-later | [element-hq/element-call](https://github.com/element-hq/element-call) |
| Cinny | `v4.12.8` web app, the `cinny` submodule of `cinny-desktop` (`cinny/UPSTREAM_TAG`) | AGPL-3.0-only | [cinnyapp/cinny](https://github.com/cinnyapp/cinny) |
| Cinny Desktop | `v4.12.8` Tauri shell around that web app (`cinny/UPSTREAM_TAG`) | AGPL-3.0-only | [cinnyapp/cinny-desktop](https://github.com/cinnyapp/cinny-desktop) |
| FluffyChat | `v2.11.3` Android build (`fluffychat/UPSTREAM_TAG`) | AGPL-3.0-or-later | [krille-chan/fluffychat](https://github.com/krille-chan/fluffychat) |
| Element X | `v26.10.1` Android build (`element-x/pins.env`) | AGPL-3.0-or-later | [element-hq/element-x-android](https://github.com/element-hq/element-x-android) |

## Noise suppression

| Project | What we take | License | Upstream |
| --- | --- | --- | --- |
| DeepFilterNet | `deep_filter` crate `v0.5.6` in FluffyChat; the DFN3 model used by it and by the web clients | MIT OR Apache-2.0 | [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) |
| mezon-noise-suppression | `noise/vendor/dfn.esm.js`, the WASM binding around DeepFilterNet3 (`noise/vendor/LICENSE-*`) | MIT OR Apache-2.0 | [mezonai/mezon-noise-suppression](https://github.com/mezonai/mezon-noise-suppression) |

## Error reporting

| Project | What we take | License | Upstream |
| --- | --- | --- | --- |
| GlitchTip | the error tracking server the clients report to | MIT | [glitchtip/glitchtip-backend](https://gitlab.com/glitchtip/glitchtip-backend) |
| Sentry JavaScript SDK | `@sentry/browser` and `@sentry/react` in Element Web, Cinny and Element Call | MIT | [getsentry/sentry-javascript](https://github.com/getsentry/sentry-javascript) |
| Sentry Electron SDK | `@sentry/electron` in Element Desktop | MIT | [getsentry/sentry-electron](https://github.com/getsentry/sentry-electron) |
| Sentry Android SDK | `io.sentry:sentry-android` in Element X | MIT | [getsentry/sentry-java](https://github.com/getsentry/sentry-java) |
| Sentry Flutter SDK | `sentry_flutter` in FluffyChat | MIT | [getsentry/sentry-dart](https://github.com/getsentry/sentry-dart) |
