#!/usr/bin/env bash
# Pack the repository into the source tarball linked from the join page.
#
#   scripts/pack-sources.sh <version> [output dir]
#
# The archive is the git tree at HEAD, so it always matches whatever CI built
# from that commit. Upstream projects are referenced by tag and digest in
# README.md rather than copied here.
set -euo pipefail

VERSION="${1:?usage: pack-sources.sh <version> [outdir]}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${2:-$(pwd)}"
NAME="plotina-client-src-${VERSION}"

mkdir -p "$OUT"
git -C "$ROOT" archive --format=tar.gz --prefix="${NAME}/" -o "$OUT/${NAME}.tar.gz" HEAD

cd "$OUT"
sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256"
ls -lh "${NAME}.tar.gz" "${NAME}.tar.gz.sha256"
cat "${NAME}.tar.gz.sha256"
