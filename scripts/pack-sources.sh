#!/usr/bin/env bash
# Pack our source delta for the AGPL obligation and stage it for /dl/src.
#
#   scripts/pack-sources.sh <version>
#
# The archive holds only what we wrote on top of upstream: the Element Web
# overlay, the Cinny Desktop wrapper and the build scripts. Upstream sources are
# referenced by tag/digest, not copied.
set -euo pipefail

VERSION="${1:?usage: pack-sources.sh <version>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="plotina-client-src-${VERSION}"
OUT="${2:-/home/hermes/dl-src}"
STAGE="$(mktemp -d)"

mkdir -p "$OUT" "$STAGE/$NAME"
cd "$REPO"

cp -a cinny-desktop "$STAGE/$NAME/"
cp -a config/element "$STAGE/$NAME/element-overlay"
mkdir -p "$STAGE/$NAME/scripts"
cp -a scripts/bump-element.sh scripts/publish-clients.sh scripts/pack-sources.sh "$STAGE/$NAME/scripts/"

UPSTREAM_TAG="$(cat cinny-desktop/UPSTREAM_TAG 2>/dev/null || echo unknown)"
ELEMENT_FROM="$(grep -m1 '^FROM' config/element/Dockerfile | awk '{print $2}')"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

cat > "$STAGE/$NAME/SOURCE.md" <<EOF
# Source for the Plotina client builds ${VERSION}

These files are the complete modification we apply to upstream projects before
building the clients we hand out. Upstream code is not copied here; take it from
the tags and digests below. Rebuilding therefore means: fetch upstream, apply
\`apply-noise.py\` (Cinny) or build the overlay image (Element Web), run the
scripts in \`scripts/\`.

## Cinny Desktop (AGPL-3.0)

- upstream: https://github.com/cinnyapp/cinny-desktop, tag \`${UPSTREAM_TAG}\`
- patch: \`cinny-desktop/apply-noise.py\` rewrites the web dist before packaging
- overlay config: \`cinny-desktop/tauri.plotina.json\`
- builds: \`cinny-desktop/scripts/build.sh\` (Linux), plus
  \`cinny-desktop/windows/installer.nsi\` and \`build-installer.sh\` for the
  Windows installer
- denoiser assets and their checksums: \`cinny-desktop/noise.lock.json\`
- licence: AGPL-3.0, https://www.gnu.org/licenses/agpl-3.0.txt

## Element Web overlay (AGPL-3.0)

- upstream image: \`${ELEMENT_FROM}\`
- \`element-overlay/Dockerfile\` adds the noise wrapper to the stock image
- runtime code: \`element-overlay/noise/\`, including the vendored
  \`deepfilternet3-noise-filter\` (Apache-2.0, licences in \`noise/vendor/\`)
- tests: \`element-overlay/tests/\`
- licence: AGPL-3.0, https://www.gnu.org/licenses/agpl-3.0.txt

## This snapshot

- commit: ${COMMIT}
- built ${VERSION} on the build host from the files above with no further edits.
EOF

tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" "$NAME"
rm -rf "$STAGE"

cd "$OUT"
sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
ls -lh "$NAME.tar.gz" "$NAME.tar.gz.sha256"
cat "$NAME.tar.gz.sha256"
