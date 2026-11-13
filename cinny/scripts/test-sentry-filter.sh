#!/usr/bin/env bash
# Unit tests for the GlitchTip noise filter in our Sentry layer
# (patches/0001-plotina-sentry.patch, src/plotina/sentryFilter.ts).
#
#   scripts/test-sentry-filter.sh [UPSTREAM_SRC]
#
# UPSTREAM_SRC is a Cinny git checkout at the tag in UPSTREAM_TAG -- the one
# build.sh leaves in .build/cinny-desktop/cinny, and the one the workflows
# leave in cinny/upstream/cinny. Without an argument the script uses
# $CINNY_SRC, then that build directory.
#
# The tests run against the sources the build compiles, produced from scratch
# every time: the tag's tree is exported into a temporary directory and every
# patch in patches/ is applied there, so a stale working copy can neither hide
# a patch that no longer applies nor make a second run fail. node_modules is
# symlinked from UPSTREAM_SRC because the bundles are built with the esbuild
# that ships in Cinny's own dependency tree (upstream has no test runner and
# this patch does not add one); the tests themselves run on node --test.
#
# @sentry/browser is NOT installed here. The bundle aliases it to a stub that
# records what Sentry.init was handed, which is what the tests need and keeps
# them independent of the SDK version the build pins; the CI installs the real
# SDK later, in the build step.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
TAG="$(cat "$ROOT/UPSTREAM_TAG")"

SRC="${1:-${CINNY_SRC:-$ROOT/.build/cinny-desktop/cinny}}"
# A submodule checkout has .git as a file pointing at the superproject, so ask
# git rather than test for a directory.
if [ ! -d "$SRC/src" ] || ! git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  echo "test-sentry-filter: no Cinny git checkout at $SRC" >&2
  echo "  run scripts/build.sh once (it clones $TAG into .build/), or pass" >&2
  echo "  the path of the checkout it left behind." >&2
  exit 2
fi
if [ ! -x "$SRC/node_modules/.bin/esbuild" ]; then
  echo "test-sentry-filter: $SRC/node_modules is not installed (needs esbuild)" >&2
  exit 2
fi
if ! command -v git >/dev/null || ! command -v node >/dev/null; then
  echo "test-sentry-filter: needs git and node" >&2
  exit 2
fi

REV="$TAG"
if ! git -C "$SRC" rev-parse --verify --quiet "$REV^{commit}" >/dev/null; then
  REV="$(git -C "$SRC" rev-parse HEAD)"
  echo "test-sentry-filter: $TAG is not in $SRC, testing HEAD ($REV)" >&2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/plotina-sentry-filter.XXXXXX")"
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
# The stub stands in for @sentry/browser: it only has to record the options
# Sentry.init is handed, which is the part of the SDK contract our patch owns.
cat > "$WORK/src/fakeSentry.ts" <<'FAKE'
export const initCalls: unknown[] = [];

export function init(options?: unknown): void {
  initCalls.push(options);
}
FAKE

# One entry point exporting both halves: the real init (which imports the alias
# and the real filter) and the stub, so the tests can read back what init did.
cat > "$WORK/src/sentryEntry.ts" <<'ENTRY'
export * as fake from './fakeSentry';
export * as plotina from './src/plotina/sentry';
ENTRY

ESBUILD="$SRC/node_modules/.bin/esbuild"
build_bundle() {
  local dsn="$1" outfile="$2"
  "$ESBUILD" "$WORK/src/sentryEntry.ts" \
    --bundle --format=esm --platform=node --log-level=warning \
    --alias:@sentry/browser="$WORK/src/fakeSentry.ts" \
    --define:import.meta.env.VITE_SENTRY_DSN="\"$dsn\"" \
    --define:import.meta.env.VITE_SENTRY_RELEASE='"cinny@test-release"' \
    --outfile="$outfile"
}

# The build the CI ships: a DSN, so initPlotinaSentry() configures the SDK.
build_bundle 'https://public@example.invalid/1' "$WORK/reporting.mjs"
# A fork's `npm start`: no DSN, so the layer must stay completely silent.
build_bundle '' "$WORK/silent.mjs"

echo "==> node --test"
PLOTINA_SENTRY_BUNDLE="$WORK/reporting.mjs" \
  PLOTINA_SENTRY_EMPTY_BUNDLE="$WORK/silent.mjs" \
  node --test "$ROOT/tests/sentry_filter.test.mjs"
