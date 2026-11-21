#!/usr/bin/env bash
# Negative control for the diff-scoped lint gate: put each defect class the gate exists for into a
# tree that already has our patches applied, then show the gate going red on it.
#
# The defect goes into a file our patches already touch, because that is the actual question: does
# the gate see a bad line in the change set. A control that lints a file outside the change set
# would only prove that the linter runs.
#
# The gate reads the change set as "everything staged in the tree", so appending the defect and
# letting it stage is all it takes — the same path a real hunk of ours travels.
#
# Usage: negative-control.sh <work-dir>
#   expects in the environment: TREE_FF, TREE_EC, TREE_X (patched checkouts),
#   LINT_SHELLCHECK / LINT_DART / LINT_ESLINT / LINT_TS_ESLINT_MODULE / LINT_DETEKT,
#   REPO (the repository under test). Prints one PASS/FAIL line per defect class.
set -uo pipefail

work="${1:?usage: negative-control.sh <work-dir>}"
REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
gate="$REPO/scripts/lint-patches.sh"
mkdir -p "$work"

failures=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# run_gate <log> [gate args...] — the gate's output goes to <log>, exit code to $rc.
run_gate() {
    local log="$1"; shift
    "$gate" "$@" > "$log" 2>&1
    rc=$?
}

# --- shell: a gate that cannot fail ------------------------------------------------------------
# A gate that checks a variable it never sets is the defect the card names: the condition is
# decoration, the run is green whatever happens, and shellcheck's SC2154 catches exactly it.
# `[ ... ] && ok` on its own is *not* a finding at -S warning (measured), so the control uses the
# shape the linter does report rather than a shape it would silently pass.
# It goes into an existing tracked script because the shell stack lints `git ls-files`, so a
# brand-new untracked file is by definition not in the set yet — in a real change it is committed.
case_shell() {
    local file="$REPO/cinny/scripts/test-node.sh"
    [ -f "$file" ] || { fail "negative control / shell: $file is missing"; return; }
    cp "$file" "$work/test-node.sh.orig"
    cat >> "$file" << 'SH'

# Negative control only: this gate checks a variable nothing ever assigns.
if [ "$plotina_failures" -eq 0 ]; then
  echo "clean"
fi
SH
    run_gate "$work/negctl-shell.log" --stack shell
    local name="negative control / shell: a gate that checks an unset variable is caught"
    if [ "$rc" -eq 0 ]; then
        fail "$name (exit 0 — shellcheck did not flag the appended check)"
    elif ! grep -q 'test-node.sh' "$work/negctl-shell.log"; then
        fail "$name (exit $rc but the file is not named in the output)"
    else
        pass "$name ($(grep -c '^OURS' "$work/negctl-shell.log") finding(s), exit $rc)"
    fi
    cp "$work/test-node.sh.orig" "$file"
}

# --- dart: an empty catch and a forgotten Future -----------------------------------------------
case_dart() {
    local tree="$TREE_FF"
    local file="$tree/lib/utils/plotina_contact_names.dart"
    cp "$file" "$work/plotina_contact_names.dart.orig"
    cat >> "$file" << 'DART'

Future<void> negativeControlDart(Object? content) async {
  try {
    parsePlotinaContactNames(content);
  } catch (e) {}
  negativeControlDart(null).then((_) => print('done'));
}
DART
    run_gate "$work/negctl-dart.log" --stack dart --tree "fluffychat=$tree"
    local name="negative control / dart: empty catch + forgotten Future in a file our patch touches"
    if [ "$rc" -eq 0 ]; then
        fail "$name (exit 0 — the analyser accepted the defect)"
    elif ! grep -q 'plotina_contact_names.dart' "$work/negctl-dart.log"; then
        fail "$name (exit $rc but the file is not named)"
    else
        pass "$name ($(grep -c '^OURS' "$work/negctl-dart.log") finding(s), exit $rc)"
    fi
    cp "$work/plotina_contact_names.dart.orig" "$file"
}

# --- ts: a floating promise and an empty catch -------------------------------------------------
case_ts() {
    local tree="$TREE_EC"
    local file="$tree/src/plotina/noiseLevel.ts"
    [ -f "$file" ] || { fail "negative control / ts: $file is missing"; return; }
    cp "$file" "$work/noiseLevel.ts.orig"
    cat >> "$file" << 'TS'

export function negativeControlTs(work: () => Promise<void>, failing: () => void): void {
  work();
  try {
    failing();
  } catch (e) {}
}
TS
    run_gate "$work/negctl-ts.log" --stack ts --tree "element-call=$tree"
    local name="negative control / ts: floating promise + empty catch in a file our patch touches"
    if [ "$rc" -eq 0 ]; then
        fail "$name (exit 0 — eslint accepted the defect)"
    elif ! grep -q 'noiseLevel.ts' "$work/negctl-ts.log"; then
        fail "$name (exit $rc but the file is not named)"
    else
        pass "$name ($(grep -c '^OURS' "$work/negctl-ts.log") finding(s), exit $rc)"
    fi
    cp "$work/noiseLevel.ts.orig" "$file"
}

# --- kotlin: a swallowed exception and an empty catch ------------------------------------------
case_kotlin() {
    local tree="$TREE_X"
    local file="$tree/app/src/main/kotlin/io/element/android/x/updater/PlotinaUpdate.kt"
    [ -f "$file" ] || { fail "negative control / kotlin: $file is missing"; return; }
    cp "$file" "$work/PlotinaUpdate.kt.orig"
    cat >> "$file" << 'KT'

internal fun negativeControlKotlin(work: () -> Unit) {
    try {
        work()
    } catch (e: Exception) {
    }
}
KT
    run_gate "$work/negctl-kotlin.log" --stack kotlin --tree "element-x=$tree"
    local name="negative control / kotlin: a swallowed exception in a file our patch touches"
    if [ "$rc" -eq 0 ]; then
        fail "$name (exit 0 — detekt accepted the defect)"
    elif ! grep -q 'PlotinaUpdate.kt' "$work/negctl-kotlin.log"; then
        fail "$name (exit $rc but the file is not named)"
    else
        pass "$name ($(grep -c '^OURS' "$work/negctl-kotlin.log") finding(s), exit $rc)"
    fi
    cp "$work/PlotinaUpdate.kt.orig" "$file"
}

case_shell
case_dart
case_ts
case_kotlin

printf '\nnegative control: %s failure(s)\n' "$failures"
[ "$failures" -eq 0 ]
