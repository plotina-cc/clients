#!/usr/bin/env bash
# Assemble the Element Web bundle that the desktop shell embeds.
#
#   scripts/prepare-webapp.sh [--dest element-desktop/.build/webapp]
#
# The desktop shell has no way to load a remote webapp: upstream packs a webapp
# directory into webapp.asar and serves it from vector://vector/webapp/. This
# script produces that directory: the pinned upstream release build plus our
# noise overlay and config.json.
#
# WEBAPP_DIR  use an already unpacked webapp instead of the release tarball, for
#             example `docker cp plotina/element-web-1.12.32:/app webapp`.
# WORK        where the tarball and the assembly live (default: .build)
# NOISE       where the DeepFilterNet3 assets are downloaded (default: noise)
# PYTHON      interpreter to use (default: python3, falling back to python)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
REPO_ROOT="$(dirname "$ROOT")"
WORK="${WORK:-$ROOT/.build}"
NOISE="${NOISE:-$ROOT/noise}"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"
DEST="$WORK/webapp"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a path}"; shift 2 ;;
    *) echo "usage: $0 [--dest <dir>]" >&2; exit 2 ;;
  esac
done

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python
command -v "$PYTHON" >/dev/null 2>&1 || { echo "prepare-webapp: no python interpreter" >&2; exit 1; }

echo "==> webapp for $TAG"
rm -rf "$DEST"
mkdir -p "$DEST"

if [ -n "${WEBAPP_DIR:-}" ]; then
  [ -f "$WEBAPP_DIR/index.html" ] || { echo "prepare-webapp: $WEBAPP_DIR has no index.html" >&2; exit 1; }
  echo "    from $WEBAPP_DIR"
  cp -a "$WEBAPP_DIR/." "$DEST/"
else
  LOCK_LINE="$("$PYTHON" - "$ROOT/webapp.lock.json" "$TAG" <<'PY'
import json
import sys

lock = json.load(open(sys.argv[1], encoding="utf-8"))
tag = sys.argv[2]
if lock.get("tag") != tag:
    sys.exit(f"webapp.lock.json pins {lock.get('tag')!r} but UPSTREAM_TAG is {tag!r}: update both together")
print(lock["url"], lock["sha256"])
PY
  )"
  URL="${LOCK_LINE%% *}"
  SHA="${LOCK_LINE##* }"
  TARBALL="$WORK/$(basename "$URL")"
  if [ -f "$TARBALL" ] && echo "$SHA  $TARBALL" | sha256sum -c - >/dev/null 2>&1; then
    echo "    cached $TARBALL"
  else
    echo "    fetch $URL"
    curl -fL --retry 3 --max-time 3600 -o "$TARBALL.part" "$URL"
    echo "$SHA  $TARBALL.part" | sha256sum -c -
    mv "$TARBALL.part" "$TARBALL"
  fi
  tar xzf "$TARBALL" -C "$DEST" --strip-components=1
fi

echo "==> noise layer"
mkdir -p "$NOISE/vendor"
cp "$REPO_ROOT/noise/logic.js" "$REPO_ROOT/noise/boot.js" "$NOISE/"
cp -a "$REPO_ROOT/noise/vendor/." "$NOISE/vendor/"

echo "==> noise assets"
"$PYTHON" "$REPO_ROOT/cinny/scripts/fetch-noise.py" --dest "$NOISE"

echo "==> overlay"
"$PYTHON" "$ROOT/apply-noise.py" --webapp "$DEST" --noise "$NOISE" \
  --config "$REPO_ROOT/element-web/config.json"

echo "==> verify"
grep -q 'noise/boot.js' "$DEST/index.html"
grep -q 'noise/logic.js' "$DEST/index.html"
test -f "$DEST/noise/vendor/dfn.esm.js"
test -f "$DEST/noise/dfn/v3/pkg/df_bg.wasm"
test -f "$DEST/noise/dfn/v3/models/DeepFilterNet3_onnx.tar.gz"
test -f "$DEST/config.json"

echo "webapp ready: $DEST ($(du -sh "$DEST" | cut -f1))"
