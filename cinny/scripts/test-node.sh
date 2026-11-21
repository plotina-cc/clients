#!/usr/bin/env bash
# Every node suite under cinny/tests/ in one command, with the count asserted.
#
#   scripts/test-node.sh [UPSTREAM_SRC]
#
# Two harnesses, because the suites need different bundles before they can run:
#   scripts/test-dm-aliases.sh  -> tests/contact_names.test.mjs, tests/member_names.test.mjs
#   scripts/test-lite-calls.sh  -> tests/plotina_account_data.test.mjs
# Both export the pinned upstream tag, apply cinny/patches/ to it and bundle the
# patched modules with Cinny's own esbuild, so this script only has to run them
# and add up what they report. It exists because CI must fail when a node suite
# fails or silently does not run: a harness invoked without a gate can exit 0
# having tested nothing (no node --test lines at all), and that is invisible in
# a log a human skims.
#
# UPSTREAM_SRC is a Cinny git checkout at UPSTREAM_TAG -- what the workflows
# leave in cinny/upstream/cinny. Both harnesses export from it into their own
# temporary tree, so the working copy here is only read.
#
# Exit 0 only when every harness passed AND the reported test count matched the
# number of suites that ran. A dropped suite file, a rename, or a harness that
# died before node --test all show up as a count mismatch, not as a green run.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

# The count is a contract, not a nag: the card's DoD is "40 node tests run in
# CI". Bumping it is a visible edit in the diff that adds or removes a suite.
EXPECTED=40

SRC="${1:-${CINNY_SRC:-$ROOT/upstream/cinny}}"
# Absolute, always: both harnesses symlink "$SRC/node_modules" INTO a temporary
# export tree (`ln -s "$SRC/node_modules" "$WORK/src/node_modules"`), and a
# relative target would be resolved from the temp dir -- node then reports
# "Cannot find module /tmp/.../src/node_modules/matrix-js-sdk" on CI while the
# same command works when run from the repository root by hand.
SRC="$(cd "$SRC" && pwd)"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/plotina-node-tests.XXXXXX")"

TOTAL=0
FAILED=0

run_harness() {
  local script="$1" log="$LOGS/$2"
  echo "==> $(basename "$script")"
  # Tee: the CI log must carry node's own lines (the test names, the summary),
  # the file is what the count is read from.
  bash "$HERE/$script" "$SRC" 2>&1 | tee "$log"
  local status=${PIPESTATUS[0]}
  # node --test prints a spec summary on a TTY-less node 20+ ("ℹ tests 33")
  # and a TAP one with --test-reporter=tap ("# tests 33").
  local count
  count="$(sed -n 's/^[ℹ#] tests \([0-9][0-9]*\)$/\1/p' "$log" | tail -1)"
  if [ "$status" -ne 0 ]; then
    echo "FAILED: $(basename "$script") exited $status" >&2
    FAILED=1
  elif [ -z "${count:-}" ]; then
    echo "FAILED: $(basename "$script") reported no node tests (it did not run them)" >&2
    FAILED=1
  else
    echo "ok: $count tests from $(basename "$script")"
    TOTAL=$((TOTAL + count))
  fi
}

run_harness test-dm-aliases.sh dm-aliases.log
run_harness test-lite-calls.sh lite-calls.log

if [ "$FAILED" -ne 0 ]; then
  echo "NODE TESTS FAILED" >&2
  exit 1
fi
if [ "$TOTAL" -ne "$EXPECTED" ]; then
  echo "NODE TEST COUNT MISMATCH: ran $TOTAL tests, the suites are pinned at $EXPECTED" >&2
  echo "  a suite file was added or dropped -- update EXPECTED here too" >&2
  exit 1
fi
echo "cinny node tests: $TOTAL passed"
