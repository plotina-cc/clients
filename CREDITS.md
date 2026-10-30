# What the Plotina clients are built from

Each client is an upstream release plus the patch layer in this repository. The
patch layer is AGPL-3.0 and follows the upstream licence of the client it
applies to: AGPL-3.0-or-later for Element Web, Element Desktop, Element Call,
Element X and FluffyChat; AGPL-3.0-only for Cinny and Cinny Desktop. Upstream
versions are pinned in the files named in the tables.

The repository is public: <https://github.com/plotina-cc/clients>. `SOURCE.md`
gives the exact upstream tag and overlay directory for every build, and the
commands that reassemble it.

## Clients

| Project | What we take | Licence | Upstream source (pinned) |
| --- | --- | --- | --- |
| Element Web | `v1.12.32` web client (`element-web/Dockerfile`) | AGPL-3.0-or-later | [element-hq/element-web @ v1.12.32](https://github.com/element-hq/element-web/tree/v1.12.32) |
| Element Desktop | `v1.12.32`, the `apps/desktop` Electron shell (`element-desktop/UPSTREAM_TAG`) | AGPL-3.0-or-later | [element-hq/element-web @ v1.12.32](https://github.com/element-hq/element-web/tree/v1.12.32) |
| Element Call | `v0.26.1` web app, also bundled in Element X (`element-call/pins.env`) | AGPL-3.0-or-later | [element-hq/element-call @ v0.26.1](https://github.com/element-hq/element-call/tree/v0.26.1) |
| Cinny | `v4.12.8` web app, the `cinny` submodule of `cinny-desktop` (`cinny/UPSTREAM_TAG`) | AGPL-3.0-only | [cinnyapp/cinny @ v4.12.8](https://github.com/cinnyapp/cinny/tree/v4.12.8) |
| Cinny Desktop | `v4.12.8` Tauri shell around that web app (`cinny/UPSTREAM_TAG`) | AGPL-3.0-only | [cinnyapp/cinny-desktop @ v4.12.8](https://github.com/cinnyapp/cinny-desktop/tree/v4.12.8) |
| FluffyChat | `v2.11.3` Android build (`fluffychat/UPSTREAM_TAG`) | AGPL-3.0-or-later | [krille-chan/fluffychat @ v2.11.3](https://github.com/krille-chan/fluffychat/tree/v2.11.3) |
| Element X | `v26.10.1` Android build (`element-x/pins.env`) | AGPL-3.0-or-later | [element-hq/element-x-android @ v26.10.1](https://github.com/element-hq/element-x-android/tree/v26.10.1) |

Element Web and Element Desktop are also offered by Element under
GPL-3.0-or-later or a commercial licence; Element Call and Element X under a
commercial licence. The builds here use the AGPL option.

## Noise suppression

| Project | What we take | Licence | Upstream source (pinned) |
| --- | --- | --- | --- |
| DeepFilterNet | `deep_filter` crate `v0.5.6` in FluffyChat; the DFN3 model used by it and by the web clients | MIT OR Apache-2.0 | [Rikorose/DeepFilterNet @ v0.5.6](https://github.com/Rikorose/DeepFilterNet/tree/v0.5.6) |
| mezon-noise-suppression | `noise/vendor/dfn.esm.js`, the WASM binding around DeepFilterNet3 (`noise/vendor/LICENSE-*`) | MIT OR Apache-2.0 | [mezonai/mezon-noise-suppression](https://github.com/mezonai/mezon-noise-suppression) |

## Error reporting

| Project | What we take | Licence | Upstream source |
| --- | --- | --- | --- |
| GlitchTip | the error tracking server the clients report to | MIT | [glitchtip/glitchtip-backend](https://gitlab.com/glitchtip/glitchtip-backend) |
| Sentry JavaScript SDK | `@sentry/browser` and `@sentry/react` in Element Web, Cinny and Element Call | MIT | [getsentry/sentry-javascript](https://github.com/getsentry/sentry-javascript) |
| Sentry Electron SDK | `@sentry/electron` in Element Desktop | MIT | [getsentry/sentry-electron](https://github.com/getsentry/sentry-electron) |
| Sentry Android SDK | `io.sentry:sentry-android` in Element X | MIT | [getsentry/sentry-java](https://github.com/getsentry/sentry-java) |
| Sentry Flutter SDK | `sentry_flutter` in FluffyChat | MIT | [getsentry/sentry-dart](https://github.com/getsentry/sentry-dart) |

## Components in the Android builds

| Project | What we take | Licence | Upstream source (pinned) |
| --- | --- | --- | --- |
| Element Call Android | the prebuilt call AAR inside Element X (`element-x/pins.env`) | AGPL-3.0-or-later | [element-hq/element-call-android @ v0.1.0-rc.8](https://github.com/element-hq/element-call-android/tree/v0.1.0-rc.8) |

## Copyright and where the source is

Our changes: Copyright (C) 2026 Plotina contributors, AGPL-3.0. Upstream
copyright notices remain with their authors and are retained in the upstream
sources named above.

For a build, the Corresponding Source is the upstream tag in the table plus this
repository at the release tag. GitHub's automatic "Source code" archives for a
tag contain only the patch layer, not the upstream tree; `SOURCE.md` lists the
pairs and the rebuild commands.

This table covers the projects we patch, vendor or configure. It is not a
complete transitive dependency inventory: upstream lockfiles (`pnpm-lock.yaml`,
`pubspec.lock`, Gradle files) and the open-source licence screens inside Element
X and FluffyChat carry the rest.
