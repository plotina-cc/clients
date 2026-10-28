# plotina.cc clients

Modifications we apply to third-party Matrix clients before shipping them to the
plotina.cc community, so that voice calls get real noise suppression without the
user touching a setting.

The point of this repository is to keep the delta, not a fork: each upstream
project is taken at a pinned tag (or image digest) and our changes are applied by
the build scripts here. That keeps rebasing onto a new upstream release cheap and
satisfies the AGPL obligation — the source of every binary we hand out is the
upstream tag plus the files in this repository.

## What is here

- `noise/` — the shared web layer: `logic.js` (which `getUserMedia` calls count
  as call audio, level clamping, UI strings), `boot.js` (the wrapper on
  `navigator.mediaDevices.getUserMedia`), `cinny-ui.js` (settings block for Cinny
  Web) and the vendored DeepFilterNet3 bundle in `noise/vendor/`. Element Web,
  Element Desktop, Cinny Web and Cinny Desktop all ship this same code.
- `element-web/` — overlay for Element Web: a `Dockerfile` that starts from the
  pinned upstream image and drops `noise/` into `/app/noise` plus one `<script>`
  tag. Tests in `element-web/tests/`.
- `element-desktop/` — the Electron shell from `apps/desktop` of the same
  element-web tag, with the pinned upstream webapp plus the `noise/` overlay
  baked into `webapp.asar`. Details in `element-desktop/README.md`.
- `cinny/` — everything Cinny in one place: the static patch for the web client
  on `cinny.plotina.cc` and the Tauri/NSIS packaging for the desktop build, both
  consuming `noise/`. Details in `cinny/README.md`.
- `scripts/bump-element.sh` — re-resolves the upstream Element Web digest,
  rebuilds, runs both test suites and restores the Dockerfile if anything fails.
- `scripts/publish-clients.sh` — copies built files to the edge host under stable
  and versioned names and refreshes the join page.
  that page.

The Cinny Web counterpart (settings block for `cinny.plotina.cc`) is
`noise/cinny-ui.js`, deployed together with the rest of `noise/`.

## Upstream pins

- Element Web: the `FROM` line in `element-web/Dockerfile`, pinned by tag **and**
  digest.
- Element Desktop: `element-desktop/UPSTREAM_TAG` (element-web tag, which now
  contains `apps/desktop`) and the webapp tarball in
  `element-desktop/webapp.lock.json`, pinned by SHA-256.
- Cinny Desktop: `cinny/UPSTREAM_TAG`.
- Denoiser assets: `cinny/noise.lock.json` and the SHA-256 pins in
  `element-web/Dockerfile` (wasm and model are vendored, never fetched at
  runtime).

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

The full sequence, including the Windows cross-build and the NSIS step, is in
`cinny/README.md`. The Element Desktop build clones the pinned element-web tag,
drops the pinned upstream webapp plus `noise/` into `webapp.asar` and lets
electron-builder package it; `element-desktop/README.md` has the details. CI does
the same thing on GitHub runners: `.github/workflows/build-cinny-desktop.yml` and
`.github/workflows/build-element-desktop.yml` trigger on a `v*-plotina.*` tag and
attach the installers to the release.

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
code in `noise/vendor/`.
