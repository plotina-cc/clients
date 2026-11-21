#!/usr/bin/env bash
# Tests for element-x/scripts/check-test-results.sh.
#
# The gate under test reads the JUnit XML that Gradle's test tasks leave behind and fails when a
# Plotina test class is missing or reports fewer tests than it should. Its whole value is that it
# cannot be green when the tests did not run, so every case here asks: does the script refuse the
# wrong input with the right reason?
#
# Run: element-x/scripts/tests/check-test-results-tests.sh

set -u

here="$(cd "$(dirname "$0")" && pwd)"
scripts_dir="$(dirname "$here")"
gate="$scripts_dir/check-test-results.sh"

work_root="${TMPDIR:-/tmp}/plotina-test-results-tests.$$"
mkdir -p "$work_root" || exit 2

failures=0
case_no=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# new_case -> $CASE (stands in for the upstream checkout), $EXP (the expectations file)
new_case() {
  case_no=$((case_no + 1))
  CASE="$work_root/case$case_no"
  EXP="$CASE-expected.txt"
  mkdir -p "$CASE"
  : > "$EXP"
}

# expect <gradle-path> <test-class-fqn> <test-count>  — one expected test class.
expect() { printf '%s %s %s\n' "$1" "$2" "$3" >> "$EXP"; }

# results_dir <gradle-path> -> where Gradle writes that module's XML, relative to the checkout.
results_dir() {
  local m="${1#:}"
  printf '%s/%s/build/test-results/testDebugUnitTest' "$CASE" "${m//://}"
}

# suite <gradle-path> <class> <tests> [failures] [errors]
# Writes XML at the path Gradle really uses, so the gate is tested against the real layout.
suite() {
  local module="$1" class="$2" n="$3" f="${4:-0}" e="${5:-0}"
  local dir
  dir="$(results_dir "$module")"
  mkdir -p "$dir"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<testsuite name="%s" tests="%s" skipped="0" failures="%s" errors="%s" time="0.01">\n' \
      "$class" "$n" "$f" "$e"
    local i=0
    while [ "$i" -lt "$n" ]; do
      printf '  <testcase name="case%s()" classname="%s" time="0.001"/>\n' "$i" "$class"
      i=$((i + 1))
    done
    printf '</testsuite>\n'
  } > "$dir/TEST-$class.xml"
}

run_gate() { "$gate" "$CASE" "$EXP" > "$CASE-out.txt" 2>&1; echo $?; }
out() { tr '\n' '|' < "$CASE-out.txt"; }

# --- case: every expected class reports exactly its count --------------------------------
new_case
expect ":app" app.PlotinaUpdateTest 3
expect ":libraries:matrix:api" api.PlotinaContactNamesTest 2
suite ":app" app.PlotinaUpdateTest 3
suite ":libraries:matrix:api" api.PlotinaContactNamesTest 2
rc=$(run_gate)
if [ "$rc" = 0 ] && grep -q '5 test' "$CASE-out.txt"; then
  pass "counts tests across modules and passes at the expectation"
else
  fail "expected exit 0 and a 5-test total, got exit $rc: $(out)"
fi

# --- case: a class reports fewer tests than expected (one silently skipped) -------------
new_case
expect ":app" app.PlotinaUpdateTest 3
suite ":app" app.PlotinaUpdateTest 2
rc=$(run_gate)
if [ "$rc" != 0 ] && grep -q '2 of 3' "$CASE-out.txt"; then
  pass "fails when a class reports fewer tests than expected"
else
  fail "expected a shortfall naming 2 of 3, got exit $rc: $(out)"
fi

# --- case: the class left no XML at all (its task did not run) --------------------------
new_case
expect ":app" app.PlotinaUpdateTest 3
suite ":libraries:matrix:api" api.PlotinaContactNamesTest 3
rc=$(run_gate)
if [ "$rc" != 0 ] && grep -q 'no result' "$CASE-out.txt"; then
  pass "fails when an expected class left no result behind"
else
  fail "expected a 'no result' exit, got exit $rc: $(out)"
fi

# --- case: a failed testcase is red even though the count is right ----------------------
new_case
expect ":app" app.PlotinaUpdateTest 3
suite ":app" app.PlotinaUpdateTest 3 1 0
rc=$(run_gate)
if [ "$rc" != 0 ] && grep -q 'app.PlotinaUpdateTest' "$CASE-out.txt"; then
  pass "fails when a testcase in the XML is marked failed"
else
  fail "expected a non-zero exit naming the class, got exit $rc: $(out)"
fi

# --- case: an errored testcase is red too ----------------------------------------------
new_case
expect ":app" app.PlotinaUpdateTest 3
suite ":app" app.PlotinaUpdateTest 1 0 2
rc=$(run_gate)
if [ "$rc" != 0 ] && grep -q 'app.PlotinaUpdateTest' "$CASE-out.txt"; then
  pass "fails when a testcase in the XML is marked errored"
else
  fail "expected a non-zero exit naming the class, got exit $rc: $(out)"
fi

# --- case: upstream classes do not stand in for a missing Plotina one -------------------
new_case
expect ":app" app.PlotinaUpdateTest 3
suite ":app" app.SomeUpstreamTest 40
rc=$(run_gate)
if [ "$rc" != 0 ] && grep -q 'no result' "$CASE-out.txt"; then
  pass "does not let a fat upstream class cover for a missing Plotina one"
else
  fail "an upstream class covered for a missing Plotina one: exit $rc: $(out)"
fi

# --- case: a missing expectations file is a failure, not a silent pass -----------------
new_case
rc=$("$gate" "$CASE" "$CASE/no-such-file.txt" > "$CASE-out.txt" 2>&1; echo $?)
if [ "$rc" != 0 ] && grep -qi 'expectations' "$CASE-out.txt"; then
  pass "fails when the expectations file does not exist"
else
  fail "a missing expectations file was accepted: exit $rc: $(out)"
fi

# --- case: a missing checkout root is named as such, not as an empty result set ------
new_case
expect ":app" app.PlotinaUpdateTest 1
rc=$("$gate" "$CASE/no-such-dir" "$EXP" > "$CASE-out.txt" 2>&1; echo $?)
if [ "$rc" != 0 ] && grep -q 'no such checkout' "$CASE-out.txt"; then
  pass "fails when the checkout root does not exist, naming the root"
else
  fail "expected a 'no such checkout' exit, got exit $rc: $(out)"
fi

# --- case: an empty expectations file is a failure, not a vacuous pass ----------------
new_case
mkdir -p "$(results_dir :app)"
rc=$(run_gate)
if [ "$rc" != 0 ]; then
  pass "fails on an empty expectations file rather than passing vacuously"
else
  fail "an empty expectations file passed: exit $rc: $(out)"
fi

printf '\n%s case(s), %s failure(s)\n' "$case_no" "$failures"
[ "$failures" -eq 0 ] || exit 1
