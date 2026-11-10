#!/usr/bin/env bash
# Unit tests for the personal-name overlay in Cinny (cc.plotina.room_aliases).
#
#   scripts/test-dm-aliases.sh [UPSTREAM_SRC]
#
# UPSTREAM_SRC is a Cinny git checkout at the tag in UPSTREAM_TAG -- the one
# build.sh leaves in .build/cinny-desktop/cinny. Without an argument the script
# uses $CINNY_SRC, then that build directory.
#
# The tests run against the sources the build compiles, produced from scratch
# every time: the tag's tree is exported into a temporary directory and every
# patch in patches/ is applied there, so a stale working copy can neither hide
# a patch that no longer applies nor make a second run fail. node_modules is
# symlinked from UPSTREAM_SRC because the bundles are built with the esbuild that
# ships in Cinny's own dependency tree (upstream has no test runner and this
# patch does not add one); the tests themselves run on node --test, node 18 or
# newer.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"

SRC="${1:-${CINNY_SRC:-$ROOT/.build/cinny-desktop/cinny}}"
if [ ! -d "$SRC/src" ] || [ ! -d "$SRC/.git" ]; then
  echo "test-dm-aliases: no Cinny git checkout at $SRC" >&2
  echo "  run scripts/build.sh once (it clones $TAG into .build/), or pass" >&2
  echo "  the path of the checkout it left behind." >&2
  exit 2
fi
if [ ! -x "$SRC/node_modules/.bin/esbuild" ]; then
  echo "test-dm-aliases: $SRC/node_modules is not installed (needs esbuild)" >&2
  exit 2
fi
if ! command -v git >/dev/null || ! command -v node >/dev/null; then
  echo "test-dm-aliases: needs git and node" >&2
  exit 2
fi

REV="$TAG"
if ! git -C "$SRC" rev-parse --verify --quiet "$REV^{commit}" >/dev/null; then
  REV="$(git -C "$SRC" rev-parse HEAD)"
  echo "test-dm-aliases: $TAG is not in $SRC, testing HEAD ($REV)" >&2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/plotina-dm-aliases.XXXXXX")"
echo "==> $REV exported to $WORK/src"
mkdir -p "$WORK/src"
git -C "$SRC" archive "$REV" | tar -x -C "$WORK/src"
ln -s "$SRC/node_modules" "$WORK/src/node_modules"

echo "==> patches"
for PATCH in "$ROOT"/patches/*.patch; do
  git -C "$WORK/src" apply "$PATCH"
  echo "applied: $(basename "$PATCH")"
done

echo "==> bundles"
# Pure storage rules: the file has no imports, so this bundle is the file.
"$SRC/node_modules/.bin/esbuild" "$WORK/src/src/plotina/roomAliases.ts" \
  --bundle --format=esm --platform=node --log-level=warning \
  --outfile="$WORK/core.mjs"

# Client glue: matrix-js-sdk stays external so the tests can install the same
# generator on a real client from the pinned SDK -- two bundled copies of
# matrix-js-sdk refuse to load side by side. It resolves through the
# node_modules symlink next to this file. The banner gives esbuild's CommonJS
# interop a real require(): matrix-widget-api (another SDK dependency) does
# require("events") at load time.
"$SRC/node_modules/.bin/esbuild" "$WORK/src/src/app/state/plotinaAliases.ts" \
  --bundle --format=esm --platform=node --log-level=warning \
  --external:matrix-js-sdk \
  --banner:js="import { createRequire as __plotinaCreateRequire } from 'node:module'; const require = __plotinaCreateRequire(import.meta.url);" \
  --outfile="$WORK/src/glue.mjs"

echo "==> node --test"
PLOTINA_ALIASES_CORE="$WORK/core.mjs" \
  PLOTINA_ALIASES_GLUE="$WORK/src/glue.mjs" \
  PLOTINA_ALIASES_SDK="$WORK/src/node_modules/matrix-js-sdk/lib/index.js" \
  node --test "$ROOT/tests/dm_aliases.test.mjs"