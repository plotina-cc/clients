#!/usr/bin/env bash
# Every suite under cinny-electron/tests/ in one command, with the count asserted.
#
#   scripts/test-node.sh
#
# The shell's suites are plain node scripts with a hand-rolled t(), not a test
# runner, so each one is started as its own process: node exits non-zero when a
# t() body throws or rejects (both were verified by feeding a deliberately
# broken case), and the script's own "N ... passed" trailer gives the count.
# Running them one by one also keeps a failure in update-channel.js from hiding
# a failure in display-media.js behind it.
#
# Why not `node --test`: none of these files export a test() from node:test, so
# the runner would report a passing file with zero tests in it -- a gate that
# cannot fail. That is exactly the shape this script has to avoid, so it counts
# what the suites reported and compares it to a pinned expectation.
#
# dev-channel + display-media + updater-channel-flow = 12 + 8 + 9.
#
# ELECTRON_SKIP_BINARY_DOWNLOAD is set by CI: the suites stub the 'electron'
# module themselves (tests/helpers/electron-stub.cjs), so the 200 MB binary is
# never downloaded -- but the package must still be INSTALLED, because updater.js
# resolves 'electron' before the stub can take over.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"

EXPECTED=29

TOTAL=0
FAILED=0
RAN=0

for suite in "$ROOT"/tests/*.test.mjs; do
  name="$(basename "$suite")"
  echo "==> $name"
  log="$(mktemp "${TMPDIR:-/tmp}/plotina-electron-suite.XXXXXX")"
  node "$suite" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  RAN=$((RAN + 1))
  # Each suite ends with "N <something> passed"/"N <something> checks passed".
  count="$(sed -n 's/^\([0-9][0-9]*\) .*passed$/\1/p' "$log" | tail -1)"
  if [ "$status" -ne 0 ]; then
    echo "FAILED: $name exited $status" >&2
    FAILED=1
  elif [ -z "${count:-}" ]; then
    echo "FAILED: $name printed no pass count (it did not finish)" >&2
    FAILED=1
  else
    echo "ok: $count checks from $name"
    TOTAL=$((TOTAL + count))
  fi
done

if [ "$RAN" -eq 0 ]; then
  echo "FAILED: no suite matched cinny-electron/tests/*.test.mjs" >&2
  exit 1
fi
if [ "$FAILED" -ne 0 ]; then
  echo "ELECTRON SHELL TESTS FAILED" >&2
  exit 1
fi
if [ "$TOTAL" -ne "$EXPECTED" ]; then
  echo "ELECTRON TEST COUNT MISMATCH: ran $TOTAL checks, the suites are pinned at $EXPECTED" >&2
  echo "  a suite was added or dropped -- update EXPECTED here too" >&2
  exit 1
fi
echo "cinny-electron node tests: $TOTAL passed in $RAN suites"
