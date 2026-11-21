#!/usr/bin/env bash
# Gate: CONTRIBUTING.md still says what the standard requires, names real things, and stays readable.
#
# Usage: scripts/tests/standard-gate.sh [path/to/CONTRIBUTING.md]
# Exit 0 = the document passes, 1 = something it must contain is missing (or it leaks internals).
#
# This gate exists because a standard nobody checks is a paragraph people delete when it is
# inconvenient. Every assertion below is a phrase the document cannot lose without losing the rule,
# and standard-negative-control.sh proves each of them can fail: a check that has never gone red is
# decoration.
#
# Matches are made against the document flattened onto one line. The markdown wraps at 110 columns,
# so a line-based grep would fire on where the wrap happened rather than on what the document says.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
doc="$repo_root/CONTRIBUTING.md"
if [ "$#" -ge 1 ]; then
  case "$1" in
    /*) doc="$1" ;;
    *) doc="$(cd "$(dirname "$1")" 2>/dev/null && pwd)/$(basename "$1")" ;;
  esac
fi

fail=0
missing() { echo "MISSING $1: $2"; fail=1; }

[ -f "$doc" ] || { echo "MISSING document: $doc"; exit 1; }

flat="$(tr -s ' \t\n' ' ' < "$doc")"
need() { case " $flat " in *"$2"*) return 0 ;; *) missing "$1" "$2"; return 1 ;; esac; }

# --- the five sections --------------------------------------------------------------------------
need "section" '## 1. Red-Green, and no decorative tests'
need "section" '## 2. Thin native wrapper'
need "section" '## 3. Minimum evidence, by kind of change'
need "section" '## 4. Definition of done: dev and QA'
need "section" '## 5. Checks do not slow the build'

# --- the rules of sections 1-4, each by its distinguishable phrase ------------------------------
need "rule" 'from **before** the fix'
need "rule" 'negative control'
need "rule" 'production creation function'
need "rule" 'readAsStringSync()'
for lvl in L1 L2 L3 L4 L5 L6 L7 L8; do
  need "level row" "| $lvl |"
done

# --- section 5: checks do not slow the build ----------------------------------------------------
# 5.1 a check is never on the critical path, and its job is a sibling of the build
need "5.1" 'sibling of the artifact build'
need "5.1" 'no `needs:` on it and nothing needing them'
need "5.1" 'test, then build'
# 5.2 a separate job has to read the shared cache instead of creating a key of its own
need "5.2" 'the shared cache'
need "5.2" 'hashes the **job name**'
# 5.3 the budgets, in numbers, and the unit they are measured in
need "5.3" '≤ 5 minutes'
need "5.3" 'no longer in wall-clock'
need "5.3" 'created_at'
need "5.3" 'path filters do not apply to tags'
# 5.4 a slow run is a cause to find, not a suite to cut
need "5.4" 'not a suite to cut'
# the three real cases the section is written around
need "5.1 case" '25.3 → 15.9 min'
need "5.1 case" '716 s'
need "5.1 case" '1133 s'
# the cross-reference back to the negative control rule
need "5.4" '§1.2'

# --- every script the document points at must exist and be executable ---------------------------
for p in $(grep -oE 'scripts/[A-Za-z0-9_./-]+\.sh' "$doc" | sort -u); do
  [ -x "$repo_root/$p" ] || missing "script" "$p (not executable in the repo)"
done

# --- public repo: no machine paths, hostnames or internal infrastructure names --------------------
if grep -nE '/home/|golova|adman-edge|plotina-cc/infra|\.hermes' "$doc"; then
  echo "LEAK: internal path or hostname in a public document"; fail=1
fi

# --- readability budget: three minutes ----------------------------------------------------------
words=$(wc -w < "$doc")
[ "$words" -le 1400 ] || { echo "TOO LONG: $words words (budget 1400)"; fail=1; }

[ "$fail" -eq 0 ] && echo "PASS: $words words, sections 1-5, rules, budgets, levels, scripts and leak check"
exit "$fail"
