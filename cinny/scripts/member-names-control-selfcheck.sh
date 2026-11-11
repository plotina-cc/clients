#!/usr/bin/env bash
# Does the negative control actually FAIL when it should?
#
# member-names-negative-control.sh passes when the member-name suite fails on the
# unpatched display point. A gate that can never fail is decoration, so this
# feeds it a suite that trivially passes and requires the gate to reject it.
#
#   bash cinny/scripts/member-names-control-selfcheck.sh [UPSTREAM_SRC]
#
# Exit 0 = the gate correctly refuses a passing suite (good).
# Exit 1 = the gate accepted a suite that proves nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
SRC="${1:-${CINNY_SRC:-$ROOT/.build/cinny-desktop/cinny}}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/plotina-control-selfcheck.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A copy of the cinny module dir with the member-name gate and a vacuous suite
# in tests/: the gate must run that suite, see it pass, and refuse.
mkdir -p "$WORK/cinny/tests" "$WORK/cinny/scripts"
cp "$ROOT/UPSTREAM_TAG" "$WORK/cinny/UPSTREAM_TAG"
cp "$ROOT/scripts/member-names-negative-control.sh" "$WORK/cinny/scripts/"
cat > "$WORK/cinny/tests/member_names.test.mjs" <<'VACUOUS'
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Proves nothing: it never loads the client and never looks at a name. The gate
// must reject this run instead of reporting a pass.
test('always passes', () => {
  assert.equal(1, 1);
});
VACUOUS

set +e
bash "$WORK/cinny/scripts/member-names-negative-control.sh" "$SRC" > "$WORK/out.txt" 2>&1
STATUS=$?
set -e

tail -5 "$WORK/out.txt"
if [ "$STATUS" -eq 0 ]; then
  echo "SELF-CHECK FAILED: the gate accepted a suite that never tested the feature" >&2
  exit 1
fi
echo "SELF-CHECK OK: the gate refused the vacuous suite (exit=$STATUS)"
