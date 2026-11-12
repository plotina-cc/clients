#!/usr/bin/env bash
# Tests for Lite's own Element Call: the mount tool and the account-data channel.
#
#   scripts/test-lite-calls.sh [UPSTREAM_SRC]
#
# UPSTREAM_SRC is a Cinny git checkout at UPSTREAM_TAG -- the one build.sh
# leaves in .build/cinny-desktop/cinny. The pinned tag is exported into a
# temporary tree and every patch in patches/ is applied there, so the tests run
# against exactly the sources the build compiles (a stale working copy cannot
# hide a patch that stopped applying).
#
# Suites
#   tests/test_element_call_mount.py       -- mounting our archive into dist/
#                                             (upstream widget = negative control)
#   tests/plotina_account_data.test.mjs    -- cc.plotina.set_account_data:
#                                             frame sender + host receiver
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"

SRC="${1:-${CINNY_SRC:-$ROOT/.build/cinny-desktop/cinny}}"
if [ ! -d "$SRC/src" ] || ! git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  echo "test-lite-calls: no Cinny git checkout at $SRC" >&2
  echo "  run scripts/build.sh once (it clones $TAG into .build/), or pass its path." >&2
  exit 2
fi
if [ ! -x "$SRC/node_modules/.bin/esbuild" ]; then
  echo "test-lite-calls: $SRC/node_modules is not installed (needs esbuild)" >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/plotina-lite-calls.XXXXXX")"
echo "==> stage in $WORK"

REV="$TAG"
if ! git -C "$SRC" rev-parse --verify --quiet "$REV^{commit}" >/dev/null; then
  REV="$(git -C "$SRC" rev-parse HEAD)"
  echo "test-lite-calls: $TAG is not in $SRC, testing HEAD ($REV)" >&2
fi
mkdir -p "$WORK/src"
git -C "$SRC" archive "$REV" | tar -x -C "$WORK/src"
ln -s "$SRC/node_modules" "$WORK/src/node_modules"

echo "==> patches"
for PATCH in "$ROOT"/patches/*.patch; do
  git -C "$WORK/src" apply "$PATCH"
  echo "applied: $(basename "$PATCH")"
done

echo "==> mount tool"
python3 -m unittest discover -s "$ROOT/tests" -p 'test_element_call_mount.py' -v

echo "==> host module bundle"
# matrix-js-sdk stays external: the test loads the real SDK through the
# node_modules symlink, and two bundled copies of it refuse to load together.
"$SRC/node_modules/.bin/esbuild" "$WORK/src/src/app/plugins/call/plotinaAccountData.ts" \
  --bundle --format=esm --platform=node --log-level=warning \
  --external:matrix-js-sdk \
  --banner:js="import { createRequire as __plotinaCreateRequire } from 'node:module'; const require = __plotinaCreateRequire(import.meta.url);" \
  --outfile="$WORK/plotina-account-data.mjs"

echo "==> account-data channel"
PLOTINA_ACCOUNT_DATA_HOST="$WORK/plotina-account-data.mjs" \
PLOTINA_ACCOUNT_DATA_SHIM="$ROOT/../element-call/plotina-account-data.js" \
PLOTINA_SDK="$WORK/src/node_modules/matrix-js-sdk/lib/index.js" \
  node --test "$ROOT/tests/plotina_account_data.test.mjs"
