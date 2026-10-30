# Corresponding source

This repository is public: <https://github.com/plotina-cc/clients>.

Every client we serve or ship is an upstream release plus the patch layer in this
repository. The source for a build is therefore two public pieces:

1. the upstream repository at the tag pinned for that client, and
2. this repository at the release tag (patches, configuration, build scripts and
   the noise wrapper).

`upstream/` is a git-ignored build cache, not part of the repository. GitHub's
automatic **Source code (zip/tar.gz)** downloads for a tag contain only this
repository's patch layer; they do not contain the upstream tree. Fetch the
upstream tag from the table as well.

## Pins

| Client | Upstream source | Pin | Overlay here | Licence |
| --- | --- | --- | --- | --- |
| Element Web | [element-hq/element-web](https://github.com/element-hq/element-web/tree/v1.12.32) | `v1.12.32` (`element-web/Dockerfile`) | `element-web/` | AGPL-3.0-or-later |
| Element Desktop | [element-hq/element-web](https://github.com/element-hq/element-web/tree/v1.12.32) | `v1.12.32` (`element-desktop/UPSTREAM_TAG`) | `element-desktop/` | AGPL-3.0-or-later |
| Element Call | [element-hq/element-call](https://github.com/element-hq/element-call/tree/v0.26.1) | `v0.26.1` (`element-call/pins.env`) | `element-call/` | AGPL-3.0-or-later |
| Cinny (web) | [cinnyapp/cinny](https://github.com/cinnyapp/cinny/tree/v4.12.8) | `v4.12.8`, the `cinny` submodule of `cinny-desktop` (`cinny/UPSTREAM_TAG`) | `cinny/` | AGPL-3.0-only |
| Cinny Desktop | [cinnyapp/cinny-desktop](https://github.com/cinnyapp/cinny-desktop/tree/v4.12.8) + [cinnyapp/cinny](https://github.com/cinnyapp/cinny/tree/v4.12.8) | `v4.12.8` (`cinny/UPSTREAM_TAG`) | `cinny/` | AGPL-3.0-only |
| FluffyChat | [krille-chan/fluffychat](https://github.com/krille-chan/fluffychat/tree/v2.11.3) | `v2.11.3` (`fluffychat/UPSTREAM_TAG`) | `fluffychat/` | AGPL-3.0-or-later |
| Element X | [element-hq/element-x-android](https://github.com/element-hq/element-x-android/tree/v26.10.1) | `v26.10.1` (`element-x/pins.env`) | `element-x/` | AGPL-3.0-or-later |

Components carried inside those builds:

| Component | Upstream source | Pin | Licence |
| --- | --- | --- | --- |
| DeepFilterNet | [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet/tree/v0.5.6) | `v0.5.6` (`fluffychat/plotina_dfn/rust/Cargo.toml`, `element-x/pins.env`) | MIT OR Apache-2.0 |
| mezon-noise-suppression | [mezonai/mezon-noise-suppression](https://github.com/mezonai/mezon-noise-suppression) | vendored file, `noise/vendor/dfn.esm.js` | MIT OR Apache-2.0 |
| Element Call Android | [element-hq/element-call-android](https://github.com/element-hq/element-call-android/tree/v0.1.0-rc.8) | `v0.1.0-rc.8` prebuilt AAR in Element X (`element-x/pins.env`) | AGPL-3.0-or-later |

## Rebuilding

The per-client READMEs have the full details; these are the entry points.

- **Element Web** — `docker build -t plotina/element-web:1.12.32 element-web/`.
  The Dockerfile starts from the pinned `vectorim/element-web` image and adds
  `noise/`, the `LICENSE-AGPL-3.0` file and the two noise `<script>` tags. The
  runtime `config.json` is `element-web/config.json`.
- **Element Desktop** — `element-desktop/scripts/build.sh`. It clones
  `element-web` at `v1.12.32`, assembles the webapp with
  `element-desktop/scripts/prepare-webapp.sh`, and builds the Electron shell.
- **Element Call** — `element-call/build.sh` (release tarball plus the overlay),
  or `element-call/build.sh --mode source` to clone `element-call` at `v0.26.1`
  and apply `element-call/patches/*.patch` before the Vite build.
- **Cinny web** — clone `cinny-desktop` at `v4.12.8` with
  `--recurse-submodules`, apply `cinny/patches/*.patch` inside its `cinny`
  submodule, run `npm ci && npm run build`, then run
  `cinny/apply-noise.py --dist <dist> --noise cinny/noise`. The noise assets are
  fetched and checksummed by `cinny/scripts/fetch-noise.py`.
- **Cinny Desktop** — `cinny/scripts/build.sh` does the clone, patches, web
  build and Tauri packaging.
- **FluffyChat** — `fluffychat/scripts/build-android.sh` clones
  `fluffychat` at `v2.11.3`, applies `fluffychat/patches/*.patch` and builds the
  APKs. The `plotina_dfn` Flutter plugin is in `fluffychat/plotina_dfn/`.
- **Element X** — the commands are in `element-x/README.md`: clone
  `element-x-android` at `v26.10.1`, apply `element-x/patches/*.patch`, add the
  Firebase resources and run the Gradle task.

The Android APK releases and the desktop installer releases name this
repository as the source; the upstream tag is the one in the table above. If a
binary reaches you without a working source link, the repository and tag above
are the source; an issue on the repository is the quickest way to report a
broken offer.
