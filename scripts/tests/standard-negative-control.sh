#!/usr/bin/env bash
# Negative control for standard-gate.sh: every case below must be REJECTED (gate exits non-zero).
#
# Usage: scripts/tests/standard-negative-control.sh [path/to/CONTRIBUTING.md]
# Exit 0 = the gate rejected every mutation and accepted the real document, 1 = something slipped through.
#
# A gate nobody has watched fail is decoration. The mutations are one per rule the standard states, plus
# the two shapes of trouble this repository has already had: a section quietly deleted, and a check whose
# budget was dropped while the prose stayed. Work happens on copies in a scratch directory; the real
# document is never modified.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
gate="$here/standard-gate.sh"
good="${1:-$repo_root/CONTRIBUTING.md}"

work="$(mktemp -d "${TMPDIR:-/tmp}/standard-negctl.XXXXXX")"
fail=0

# reject <name> <mutated file> — the gate must fail on this file.
reject() {
  local name="$1" file="$2"
  if "$gate" "$file" > "$work/err" 2>&1; then
    echo "NOT REJECTED: $name (gate exited 0 — the assertion is decoration)"
    fail=1
  else
    echo "rejected : $name -> $(head -1 "$work/err")"
  fi
}

# escape to a literal string for grep -v on whole lines
drop_line_containing() { grep -v -F "$1" "$good" > "$2"; }

# --- the gate must accept the real document -----------------------------------------------------
if "$gate" "$good" > "$work/ok" 2>&1; then
  echo "accepted : the real document -> $(cat "$work/ok")"
else
  echo "FALSE ALARM: the real document was rejected:"; cat "$work/ok"; fail=1
fi

# --- sections 1-4: the rules that were already protected ----------------------------------------
drop_line_containing 'production creation function' "$work/no-roundtrip.md"
reject "round-trip rule removed" "$work/no-roundtrip.md"

drop_line_containing 'readAsStringSync()' "$work/no-grepban.md"
reject "source-as-text ban removed" "$work/no-grepban.md"

sed '/^## 4\. Definition of done/,$d' "$good" > "$work/no-dod.md"
reject "section 4 (dev/QA DoD) removed" "$work/no-dod.md"

# --- section 5: the new rules -------------------------------------------------------------------
sed '/^## 5\. Checks do not slow the build/,$d' "$good" > "$work/no-section5.md"
reject "section 5 removed" "$work/no-section5.md"

# the budgets go, the surrounding prose stays: the exact way a budget rots into an aspiration
sed -E 's/≤ 5 minutes/a few minutes/' "$good" > "$work/no-pr-budget.md"
reject "PR budget '5 minutes' softened to 'a few minutes'" "$work/no-pr-budget.md"

drop_line_containing 'no `needs:` on it' "$work/no-needs.md"
reject "the sibling-job requirement dropped" "$work/no-needs.md"

drop_line_containing 'hashes the **job name**' "$work/no-cache-trap.md"
reject "the per-job cache trap dropped" "$work/no-cache-trap.md"

sed -E 's/no longer in wall-clock/about the same/' "$good" > "$work/no-wallclock.md"
reject "the wall-clock word replaced by 'about the same'" "$work/no-wallclock.md"

sed -E 's/`created_at` → `updated_at`/the slowest step/' "$good" > "$work/no-measure.md"
reject "run-level measurement replaced by a per-step one" "$work/no-measure.md"

drop_line_containing 'not a suite to cut' "$work/no-cause.md"
reject "slow-run rule dropped" "$work/no-cause.md"

# --- the repository-level traps the gate also covers --------------------------------------------
{ cat "$good"; echo; echo "Evidence lives in /home/hermes/reports/2026-11-22/."; } > "$work/leak.md"
reject "internal path leaked into the public document" "$work/leak.md"

{ cat "$good"; echo; echo 'Run `scripts/check-everything.sh` before merging.'; } > "$work/ghost.md"
reject "a script that does not exist is referenced" "$work/ghost.md"

{ cat "$good"; for i in $(seq 1 400); do echo "filler line $i"; done; } > "$work/bloat.md"
reject "past the three-minute reading budget" "$work/bloat.md"

# --- the RED state: on the tree before this card there is no section 5 at all -------------------
"$gate" "$work/does-not-exist.md" > /dev/null 2>&1 \
  && { echo "NOT REJECTED: missing document (gate exited 0)"; fail=1; } \
  || echo "rejected : document absent -> RED on the tree before this card"

[ "$fail" -eq 0 ] && echo "ALL NEGATIVE CONTROLS FAILED AS EXPECTED"
exit "$fail"
