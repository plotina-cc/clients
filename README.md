# plotina-clients

Modifications we apply to third-party Matrix clients before shipping them to the
plotina.cc community, so that voice calls get real noise suppression without the
user touching a setting.

The point of this repository is to keep the delta, not a fork: each upstream
project is taken at a pinned tag (or image digest) and our changes are applied by
the build scripts here. That keeps rebasing onto a new upstream release cheap and
satisfies the AGPL obligation — the source of every binary we hand out is the
upstream tag plus the files in this repository.

## What is here

- `element-web/` — overlay for Element Web: a `Dockerfile` that starts from the
  pinned upstream image and adds the noise wrapper. Runtime code lives in
  `element-web/noise/` (call-vs-voice-message discriminator, DeepFilterNet3
  vendor bundle, settings slider), tests in `element-web/tests/`.
- `cinny-desktop/` — wrapper around Cinny Desktop: patches the built web dist
  before packaging (`apply-noise.py`), Tauri overlay config, and a hand-written
  NSIS installer for Windows in `cinny-desktop/windows/`.
- `scripts/bump-element.sh` — re-resolves the upstream Element Web digest,
  rebuilds, runs both test suites and restores the Dockerfile if anything fails.
- `scripts/publish-clients.sh` — copies built files to the edge host under stable
  and versioned names and refreshes the join page.
- `scripts/pack-sources.sh` — packs this delta into the source tarball linked from
  that page.

The Cinny Web counterpart (settings block for `cinny.plotina.cc`) is
`element-web/noise/cinny-ui.js`, deployed together with the rest of `noise/`.

## Upstream pins

- Element Web: the `FROM` line in `element-web/Dockerfile`, pinned by tag **and**
  digest.
- Cinny Desktop: `cinny-desktop/UPSTREAM_TAG`.
- Denoiser assets: `cinny-desktop/noise.lock.json` and the SHA-256 pins in
  `element-web/Dockerfile` (wasm and model are vendored, never fetched at
  runtime).

## Building

Element Web image:

```
docker build -t plotina/element-web:<tag>-noise1 element-web/
element-web/tests/run.sh          # unit tests
element-web/tests/integration.sh  # end-to-end with a fake microphone
```

Cinny Desktop (Linux):

```
cd cinny-desktop
npm ci && npm run build           # inside the upstream checkout
python3 apply-noise.py --dist <upstream>/cinny/dist --noise noise
```

The full sequence, including the Windows cross-build and the NSIS step, is in
`cinny-desktop/README.md`. CI does the same thing on GitHub runners: see
`.github/workflows/build-cinny-desktop.yml`, which triggers on a `v*-plotina.*`
tag and attaches the installers to the release.

## Why the patch rather than a fork

Element Web has no hook for `getUserMedia`, and Element Call's noise suppression
is a browser constraint (`TF_NOISE_SUPPRESSION`), not a filter. The wrapper
intercepts `navigator.mediaDevices.getUserMedia`, tells call audio apart from
voice messages by the shape of the constraints, and runs the selected
DeepFilterNet3 level. Server-side denoising is impossible while calls are
end-to-end encrypted.

## Licence

AGPL-3.0 (see `LICENSE`), matching the upstream projects we derive from: Element
Web, Cinny and Cinny Desktop. Vendored third-party licences are kept next to the
code in `element-web/noise/vendor/`.
