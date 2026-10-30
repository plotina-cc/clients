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
  call view. It is on by default; there is no switch to find and nothing to
  install.

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

AGPL-3.0 (see `LICENSE`), matching the upstream projects we derive from: Element
Web, Cinny and Cinny Desktop. Vendored third-party licences are kept next to the
code in `noise/vendor/`.
