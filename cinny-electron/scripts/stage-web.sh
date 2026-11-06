#!/usr/bin/env bash
# Stage the Cinny web dist into the Electron app (web/, gitignored) so
# electron-builder bundles it inside the asar. We never depend on the shared
# /home/hermes/build dist staying alive mid-build; pass an explicit source.
#
#   LITE_DIST=/path/to/cinny/dist bash stage-web.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${LITE_DIST:?set LITE_DIST to the built Cinny web dist}"
[ -f "$SRC/index.html" ] || { echo "not a dist: $SRC/index.html missing" >&2; exit 1; }
[ -f "$SRC/sw.js" ] || { echo "not a dist: $SRC/sw.js missing (service worker)" >&2; exit 1; }
[ -f "$SRC/config.json" ] || { echo "not a dist: $SRC/config.json missing" >&2; exit 1; }
# Patch 0007 (SSO token handoff) must be baked in — the shell's opener flow
# depends on it. Accept it from any hashed bundle asset, same as Phase-1 QA.
grep -Raqs 'plotina:sso:login-token' "$SRC/assets" || {
  echo "dist is missing the plotina:sso:login-token patch marker" >&2; exit 1; }

DEST="$HERE/web"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -C "$SRC" -cf - . | tar -C "$DEST" -xf -
n=$(find "$DEST" -type f | wc -l)
echo "staged $n files ($(du -sh "$DEST" | cut -f1)) from $SRC"
