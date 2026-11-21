#!/usr/bin/env bash
# Tests for scripts/lint/findings.py — the piece that decides which lint finding belongs to a
# line *we* wrote, and therefore what the diff-scoped lint gate may fail on.
#
# The whole gate rests on one property, and it is the one a fixture can prove: a finding on a
# line a patch added fails the run, a finding on an untouched line of the same file does not.
# Every case builds a real git tree and applies a real patch to it, so the added-line ranges come
# from git itself rather than from a table written next to the assertion — a fixture on both ends
# would let the ranges and the expectations drift together and stay green.
#
# Run: scripts/tests/lint-findings-test.sh

set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
findings="$repo/scripts/lint/findings.py"

work_root="$(mktemp -d "${TMPDIR:-/tmp}/plotina-lint-tests.XXXXXX")" || exit 2
failures=0
case_no=0

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# new_case — a git tree holding one file, committed.
new_case() {
  case_no=$((case_no + 1))
  CASE="$work_root/case$case_no"
  mkdir -p "$CASE/tree"
  printf 'alpha\nbeta\ngamma\ndelta\nepsilon\n' > "$CASE/tree/lib.dart"
  git init -q "$CASE/tree"
  git -C "$CASE/tree" add -A
  git -C "$CASE/tree" -c user.email=t@example.invalid -c user.name=test commit -qm init
}

# patch_line <line> <new-text> — rewrites one line of lib.dart, the way one of our patches does.
patch_line() {
  local line="$1" text="$2"
  python3 - "$CASE/tree/lib.dart" "$line" "$text" << 'PY'
import sys
path, line, text = sys.argv[1], int(sys.argv[2]), sys.argv[3]
lines = open(path, encoding="utf-8").read().splitlines()
lines[line - 1] = text
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
}

# dart_finding <line> — one line of `dart analyze --format machine` output.
dart_finding() {
  printf 'INFO|LINT|UNAWAITED_FUTURES|%s/lib.dart|%s|3|9|Missing an'"'"'await.'"'"'\n' "$CASE/tree" "$1"
}

# run_report <format> <stdin-file> [extra args...] — exit code in rc, output in out.
run_report() {
  local format="$1" input="$2"
  shift 2
  out="$(python3 "$findings" report --format "$format" --added "$CASE/added.txt" \
    --label test --root "$CASE/tree" "$@" < "$input" 2>&1)"
  rc=$?
}

# --- added-line extraction --------------------------------------------------------------------

case_added_ranges_from_a_real_patch() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  local name="added: a rewritten line is reported as one range, at its new line number"
  if ! grep -qxF "$(printf 'lib.dart\t2-2')" "$CASE/added.txt"; then
    fail "$name (got: $(cat "$CASE/added.txt"))"
    return
  fi
  pass "$name"
}

case_added_ignores_pure_deletion() {
  new_case
  # Deleting a line leaves a hunk with a zero-length new side. Recording the
  # hunk's start line there would blame the line that moved up into its place.
  printf 'alpha\ngamma\ndelta\nepsilon\n' > "$CASE/tree/lib.dart"
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  local name="added: a pure deletion adds no range"
  if [ -s "$CASE/added.txt" ]; then
    fail "$name (got: $(cat "$CASE/added.txt"))"
    return
  fi
  pass "$name"
}

case_added_lists_only_changed_files() {
  new_case
  printf 'untouched\n' > "$CASE/tree/other.dart"
  git -C "$CASE/tree" add -A
  git -C "$CASE/tree" -c user.email=t@example.invalid -c user.name=test commit -qm other
  patch_line 5 'epsilon changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  local name="added: a file no patch changed is not in the list"
  if grep -q 'other.dart' "$CASE/added.txt"; then
    fail "$name (other.dart listed)"
    return
  fi
  if ! grep -q '^lib.dart' "$CASE/added.txt"; then
    fail "$name (lib.dart missing: $(cat "$CASE/added.txt"))"
    return
  fi
  pass "$name"
}

# --- attribution ------------------------------------------------------------------------------

case_finding_on_our_line_fails() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  dart_finding 2 > "$CASE/lint.txt"
  run_report dart "$CASE/lint.txt"
  local name="report: a finding on a line we added fails the run"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *"1 on our lines"*) ;; *) fail "$name (count missing: $out)"; return ;; esac
  pass "$name"
}

case_finding_on_upstream_line_passes() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  # Line 4 is upstream's, untouched by the patch, in the same file.
  dart_finding 4 > "$CASE/lint.txt"
  run_report dart "$CASE/lint.txt"
  local name="report: a finding on an untouched line of the same file does not fail the run"
  [ "$rc" -eq 0 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *"0 on our lines, 1 on upstream lines"*) ;;
    *) fail "$name (counts wrong: $out)"; return ;; esac
  pass "$name"
}

case_clean_run_passes() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  : > "$CASE/lint.txt"
  run_report dart "$CASE/lint.txt"
  local name="report: no findings at all is a pass"
  [ "$rc" -eq 0 ] || { fail "$name (exit $rc)"; return; }
  pass "$name"
}

case_out_of_scope_file_fails() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  # A finding in a file no patch touches: the linter was pointed at our files,
  # so this is our wiring bug and has to be visible, not dropped.
  printf 'INFO|LINT|UNAWAITED_FUTURES|%s/other.dart|1|1|9|Missing an'"'"'await.'"'"'\n' "$CASE/tree" \
    > "$CASE/lint.txt"
  run_report dart "$CASE/lint.txt"
  local name="report: a finding in a file outside the change set fails the run"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  pass "$name"
}

case_rule_filter_keeps_only_gate_rules() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  {
    printf 'INFO|LINT|AVOID_CATCHES_WITHOUT_ON_CLAUSES|%s/lib.dart|2|3|9|x.\n' "$CASE/tree"
    printf 'INFO|LINT|UNAWAITED_FUTURES|%s/lib.dart|2|3|9|y.\n' "$CASE/tree"
  } > "$CASE/lint.txt"
  run_report dart "$CASE/lint.txt" --rule UNAWAITED_FUTURES
  local name="report: --rule keeps only the codes the gate owns"
  case "$out" in
    *"1 on our lines"*) ;;
    *) fail "$name (counts wrong: $out)"; return ;;
  esac
  pass "$name"
}

case_shellcheck_json_parsed() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  printf '[{"file":"%s/lib.dart","line":2,"code":2164,"message":"cd without || exit"}]\n' \
    "$CASE/tree" > "$CASE/lint.txt"
  run_report shellcheck "$CASE/lint.txt"
  local name="report: shellcheck json1 is attributed by line"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *SC2164*) ;; *) fail "$name (rule code missing: $out)"; return ;; esac
  pass "$name"
}

case_eslint_json_parsed() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  printf '[{"filePath":"%s/lib.dart","messages":[{"line":2,"ruleId":"no-empty","message":"Empty block."}]}]\n' \
    "$CASE/tree" > "$CASE/lint.txt"
  run_report eslint "$CASE/lint.txt"
  local name="report: eslint json is attributed by line"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *no-empty*) ;; *) fail "$name (rule missing: $out)"; return ;; esac
  pass "$name"
}

# --- negative control on the harness itself ---------------------------------------------------

case_rule_filter_keeps_parse_errors() {
  new_case
  patch_line 2 'beta changed'
  python3 "$findings" added "$CASE/tree" > "$CASE/added.txt" 2>&1
  # ESLint reports an unreadable file as ruleId null, which the parser maps to `fatal`. That is not
  # a rule the gate owns, so a --rule filter that dropped it would report a clean run over a file
  # set the linter never read — a gate silently downgraded to nothing.
  printf '[{"filePath":"%s/lib.dart","messages":[{"line":1,"ruleId":null,"fatal":true,"message":"Parsing error: tsconfig not found"}]}]\n' \
    "$CASE/tree" > "$CASE/lint.txt"
  run_report eslint "$CASE/lint.txt" --rule no-empty
  local name="report: a parse error survives the rule filter instead of reading as clean"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *"Parsing error"*) ;; *) fail "$name (message missing: $out)"; return ;; esac
  pass "$name"
}

case_broken_added_file_is_not_a_pass() {
  new_case
  # An empty change set makes every finding "out of scope", so it must not be
  # read as "nothing to report": that is how a gate silently checks nothing.
  : > "$CASE/added.txt"
  dart_finding 2 > "$CASE/lint.txt"
  run_report dart "$CASE/lint.txt"
  local name="negative control: an empty change set with findings is not green"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  pass "$name"
}

case_added_ranges_from_a_real_patch
case_added_ignores_pure_deletion
case_added_lists_only_changed_files
case_finding_on_our_line_fails
case_finding_on_upstream_line_passes
case_clean_run_passes
case_out_of_scope_file_fails
case_rule_filter_keeps_only_gate_rules
case_shellcheck_json_parsed
case_eslint_json_parsed
case_rule_filter_keeps_parse_errors
case_broken_added_file_is_not_a_pass

printf '\n%s case(s), %s failure(s)\n' "$case_no" "$failures"
[ "$failures" -eq 0 ]
