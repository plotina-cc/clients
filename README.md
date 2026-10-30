# plotina.cc clients

Upstream Matrix clients shipped to the plotina.cc community with two things baked
in: our homeserver is the default, and voice calls get real noise suppression
without the user touching a setting.

## Clients

- **Element Web** — the browser client at `chat.plotina.cc`
- **Element Desktop** — Linux and Windows builds of the same client
- **Cinny** — web client at `cinny.plotina.cc`, plus a desktop build
- **Element Call** — the call UI at `call.plotina.cc`
- **FluffyChat** — Android
- **Element X** — Android

## What is baked in

- **Server.** Sign-in and rooms come from `plotina.cc`; the account service is
  `account.plotina.cc`. Nothing to type on first launch.
- **Calls.** Element Call lives at `call.plotina.cc`. Element X opens it by
  default, so calls there run on our deployment too.
- **Noise suppression.** DeepFilterNet3 is applied to the microphone before the
  track is published — in the browsers, in the desktop apps and in Element X's
  call view. It is on by default and there is nothing to install; the level can
  be changed while a call is running, from the control in the call view.

## How this repository is organised

Every client is taken from a pinned upstream release and our changes are applied
by the build scripts and CI workflows here. The delta is kept small on purpose,
so adopting a new upstream release does not turn into a fork. What we hand out is
AGPL source: the upstream tag plus this repository.

## Building

Element Web image:

```
docker build -t plotina/element-web:<tag>-noise1 element-web/
element-web/tests/run.sh          # unit tests
element-web/tests/integration.sh  # end-to-end with a fake microphone
```

Element Desktop (Linux: AppImage + deb, Windows: NSIS):

```
element-desktop/scripts/build.sh
```

Cinny Desktop (Linux):

```
cd cinny
npm ci && npm run build           # inside the upstream checkout
python3 apply-noise.py --dist <upstream>/cinny/dist --noise noise
```

CI runs the same builds on GitHub runners: `.github/workflows/build-cinny-desktop.yml`
and `.github/workflows/build-element-desktop.yml` trigger on a `v*-plotina.*` tag
and attach the installers to the release. Build details that are specific to one
client live in that client's directory.

## Windows builds

The Windows installer is not code-signed. On first launch SmartScreen shows
"Windows protected your PC" — choose "More info", then "Run anyway". The binary
is built from the same sources as every other client; we do not pay for a code
signing certificate.

## Licence

The patch layer in this repository — build scripts, patches, configuration and
the noise wrapper — is AGPL-3.0 (see `LICENSE`). It follows the upstream licence
of the client it applies to: AGPL-3.0-or-later for Element Web, Element Desktop,
Element Call, Element X and FluffyChat; AGPL-3.0-only for Cinny and Cinny
Desktop. Copyright (C) 2026 Plotina contributors. The upstream copyright
notices remain with their authors.

The builds we serve and ship combine an upstream release with this repository:

| Client | Licence | Upstream source |
| --- | --- | --- |
| Element Web | AGPL-3.0-or-later | [element-hq/element-web @ v1.12.32](https://github.com/element-hq/element-web/tree/v1.12.32) |
| Element Desktop | AGPL-3.0-or-later | [element-hq/element-web @ v1.12.32](https://github.com/element-hq/element-web/tree/v1.12.32) |
| Element Call | AGPL-3.0-or-later | [element-hq/element-call @ v0.26.1](https://github.com/element-hq/element-call/tree/v0.26.1) |
| Cinny | AGPL-3.0-only | [cinnyapp/cinny @ v4.12.8](https://github.com/cinnyapp/cinny/tree/v4.12.8) |
| Cinny Desktop | AGPL-3.0-only | [cinnyapp/cinny-desktop @ v4.12.8](https://github.com/cinnyapp/cinny-desktop/tree/v4.12.8) |
| FluffyChat | AGPL-3.0-or-later | [krille-chan/fluffychat @ v2.11.3](https://github.com/krille-chan/fluffychat/tree/v2.11.3) |
| Element X | AGPL-3.0-or-later | [element-hq/element-x-android @ v26.10.1](https://github.com/element-hq/element-x-android/tree/v26.10.1) |

Element Web and Element Desktop are also offered by Element under
GPL-3.0-or-later or a commercial licence; Element Call and Element X under a
commercial licence. All four are used here under the AGPL option. Cinny and
Cinny Desktop are AGPL-3.0-only.

Third-party components keep their own licences: DeepFilterNet and the vendored
`mezon-noise-suppression` wrapper are MIT OR Apache-2.0 (`noise/vendor/`);
GlitchTip and the Sentry SDKs are MIT. `CREDITS.md` lists them.

### Where to get the source

The repository is public: <https://github.com/plotina-cc/clients>. For a release,
the Corresponding Source is the upstream tag pinned for that client plus this
repository at the release tag; `SOURCE.md` has the exact tags, overlay
directories and rebuild commands. GitHub's automatic "Source code" archives for a
tag contain only this patch layer, not the upstream tree, so fetch both.

Element Web, Cinny and Element Call link to this repository from their footer;
Element Call's link is on its sign-in view, the only footer that app has. The
release notes of the Android APKs and the desktop installers name this
repository as the source; `SOURCE.md` gives the upstream tag that goes with it.
