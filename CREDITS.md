# What the Plotina clients are built from

Every binary we hand out is an upstream client plus a small patch layer from
this repository. Nothing here replaces the upstream project: the sources of the
unmodified parts come from the links below, at the version pinned in the build
scripts, and the patch layer is public in this repository under AGPL-3.0.

## Upstream clients

| Client | Upstream | Pinned version | License |
| --- | --- | --- | --- |
| Element Web / Element Desktop | [element-hq/element-web](https://github.com/element-hq/element-web), [element-hq/element-desktop](https://github.com/element-hq/element-desktop) | `v1.12.32` (web image by digest) | AGPL-3.0 |
| Cinny | [cinnyapp/cinny](https://github.com/cinnyapp/cinny) | `4.12.8` | AGPL-3.0 |
| FluffyChat | [krille-chan/fluffychat](https://github.com/krille-chan/fluffychat) | `v2.11.3` | AGPL-3.0 |
| Element X | [element-hq/element-x-android](https://github.com/element-hq/element-x-android) | `v26.10.1` | AGPL-3.0 |
| Element Call | [element-hq/element-call](https://github.com/element-hq/element-call) | `v0.26.1` | AGPL-3.0 |

The exact pins live next to each client: `element-web/Dockerfile`,
`cinny/desktop/UPSTREAM_TAG`, `fluffychat/UPSTREAM_TAG`,
`element-x/pins.env`, `element-call/pins.env`.

## Noise suppression

We do not implement the DSP ourselves. The web clients run
[deepfilternet3-noise-filter](https://github.com/mezonai/mezon-noise-suppression)
(`deepfilternet3-noise-filter`, Apache-2.0 OR MIT), a WASM build of
[DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (Apache-2.0 OR MIT);
FluffyChat links the `deep_filter` crate from the same project. The model and
WASM binaries are pinned by sha256 in the build scripts.

## Prior art

Upstream has the same feature pending, and these are the discussions our
approach follows:

- [element-hq/element-call#714](https://github.com/element-hq/element-call/issues/714) — noise reduction request, open since 2022.
- [element-hq/element-call#3819](https://github.com/element-hq/element-call/pull/3819) — DeepFilterNet proof of concept.
- [element-hq/element-call#3772](https://github.com/element-hq/element-call/pull/3772) — RNNoise variant.

None of that code is shipped here; the wrappers in `noise/` are ours.
