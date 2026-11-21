#!/usr/bin/env bash
# Tests for element-x/scripts/run-unit-tests.sh.
#
# The script decides what Gradle is invoked with, and the whole point of it is that it invokes
# exactly the Plotina classes and nothing else - not `./gradlew test`, not a whole module's upstream
# suite. So the cases here run the script against a stub `gradlew` that records its arguments, and
# assert on the recorded invocations.
#
# Run: element-x/scripts/tests/run-unit-tests-tests.sh

set -u

here="$(cd "$(dirname "$0")" && pwd)"
scripts_dir="$(dirname "$here")"
runner="$scripts_dir/run-unit-tests.sh"

work_root="${TMPDIR:-/tmp}/plotina-run-unit-tests.$$"
mkdir -p "$work_root" || exit 2

failures=0
case_no=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# new_case -> $CASE (the fake checkout), $EXP (the expectations file), $LOG (gradlew's record)
new_case() {
  case_no=$((case_no + 1))
  CASE="$work_root/case$case_no"
  EXP="$CASE-expected.txt"
  LOG="$CASE-gradle.log"
  mkdir -p "$CASE"
  : > "$EXP"
  : > "$LOG"

  # A stub ./gradlew: records its arguments, one invocation per line ('|' between them), and exits
  # with whatever the case put in ./gradlew.exit so a red module can be simulated.
  cat > "$CASE/gradlew" << 'STUB'
#!/usr/bin/env bash
printf '%s\n' "$(printf '%s|' "$@")" >> "$LOG_PATH"
exit "$(cat "$(dirname "$0")/gradlew.exit" 2>/dev/null || echo 0)"
STUB
  chmod +x "$CASE/gradlew"
  printf '0\n' > "$CASE/gradlew.exit"
}

expect() { printf '%s %s %s\n' "$1" "$2" "$3" >> "$EXP"; }

run_runner() {
  LOG_PATH="$LOG" "$runner" "$CASE" "$EXP" --no-configuration-cache > "$CASE-out.txt" 2>&1
  echo $?
}
out() { tr '\n' '|' < "$CASE-out.txt"; }

# --- case: one module, one class: one invocation, filtered to that class ---------------
new_case
expect ":app" io.element.android.x.updater.PlotinaUpdateTest 21
rc=$(run_runner)
if [ "$rc" = 0 ] \
   && grep -q ':app:testGplayDebugUnitTest|' "$LOG" \
   && grep -q -- '--tests|io.element.android.x.updater.PlotinaUpdateTest|' "$LOG"; then
  pass "runs the app module's gplay unit tests filtered to the Plotina class"
else
  fail "expected a filtered gplay invocation, exit $rc: $(out) log: $(tr '\n' '|' < "$LOG")"
fi

# --- case: a library module gets the plain debug task ---------------------------------
new_case
expect ":libraries:matrix:api" io.element.android.libraries.matrix.api.room.alias.PlotinaContactNamesTest 26
rc=$(run_runner)
if [ "$rc" = 0 ] && grep -q ':libraries:matrix:api:testDebugUnitTest|' "$LOG"; then
  pass "runs a library module's debug unit tests"
else
  fail "expected the debug task of the library, exit $rc: log: $(tr '\n' '|' < "$LOG")"
fi

# --- case: two modules are two invocations, each with only its own classes -----------
# A single invocation with both modules' --tests filters fails: Gradle rejects a filter that
# matches no class in any of the requested tasks.
new_case
expect ":app" io.element.android.x.ATest 1
expect ":libraries:matrix:impl" io.element.android.libraries.matrix.impl.BTest 1
rc=$(run_runner)
app_line=$(grep ':app:testGplayDebugUnitTest|' "$LOG")
lib_line=$(grep ':libraries:matrix:impl:testDebugUnitTest|' "$LOG")
if [ "$rc" = 0 ] && [ "$(wc -l < "$LOG")" -eq 2 ] \
   && [ -n "$app_line" ] && [ -n "$lib_line" ] \
   && case "$app_line" in *BTest*) false ;; *) true ;; esac \
   && case "$lib_line" in *ATest*) false ;; *) true ;; esac; then
  pass "invokes Gradle once per module, each with only that module's classes"
else
  fail "expected two separate filtered invocations, exit $rc: log: $(tr '\n' '|' < "$LOG")"
fi

# --- case: several classes in one module share one invocation ------------------------
new_case
expect ":app" io.element.android.x.ATest 1
expect ":app" io.element.android.x.BTest 2
expect ":app" io.element.android.x.updater.CTest 3
rc=$(run_runner)
if [ "$rc" = 0 ] && [ "$(wc -l < "$LOG")" -eq 1 ] \
   && grep -q -- '--tests|io.element.android.x.ATest|' "$LOG" \
   && grep -q -- '--tests|io.element.android.x.BTest|' "$LOG" \
   && grep -q -- '--tests|io.element.android.x.updater.CTest|' "$LOG"; then
  pass "passes every class of a module to one invocation"
else
  fail "expected one invocation carrying all three filters, exit $rc: log: $(tr '\n' '|' < "$LOG")"
fi

# --- case: it never asks for a bare `test` task --------------------------------------
# The card's whole constraint: no whole-module, let alone whole-monorepo, test run.
new_case
expect ":features:home:impl" io.element.android.features.home.impl.RoomListDataSourceTest 6
rc=$(run_runner)
if [ "$rc" = 0 ] && ! grep -qE '\|test\||\|test:|^\s*test\s*\|' "$LOG"; then
  pass "never invokes a bare 'test' task"
else
  fail "a bare test task reached Gradle, exit $rc: log: $(tr '\n' '|' < "$LOG")"
fi

# --- case: a red module is named, and the others still run --------------------------
# One push should tell the whole story, not one failing module at a time.
new_case
expect ":app" io.element.android.x.ATest 1
expect ":libraries:matrix:impl" io.element.android.libraries.matrix.impl.BTest 1
printf '1\n' > "$CASE/gradlew.exit"
rc=$(run_runner)
if [ "$rc" != 0 ] && [ "$(wc -l < "$LOG")" -eq 2 ] && grep -q 'testGplayDebugUnitTest failed' "$CASE-out.txt"; then
  pass "runs every module and exits non-zero, naming the failing task"
else
  fail "expected both invocations and a non-zero exit, exit $rc: $(out) log: $(tr '\n' '|' < "$LOG")"
fi

# --- case: an empty expectations file is an error, not a green no-op ----------------
new_case
rc=$(run_runner)
if [ "$rc" != 0 ] && [ ! -s "$LOG" ] && grep -q 'lists no test classes' "$CASE-out.txt"; then
  pass "refuses an empty expectations file without calling Gradle"
else
  fail "an empty expectations file got a green no-op, exit $rc: $(out)"
fi

# --- case: a missing expectations file is an error, named as such ------------------
new_case
rc=$(LOG_PATH="$LOG" "$runner" "$CASE" "$CASE/no-such-file.txt" > "$CASE-out.txt" 2>&1; echo $?)
if [ "$rc" != 0 ] && [ ! -s "$LOG" ] && grep -q 'no such expectations file' "$CASE-out.txt"; then
  pass "refuses a missing expectations file, naming it, without calling Gradle"
else
  fail "expected a 'no such expectations file' exit and no Gradle call, exit $rc: $(out)"
fi

# --- case: a missing checkout is an error -----------------------------------------
new_case
expect ":app" io.element.android.x.ATest 1
rc=$(LOG_PATH="$LOG" "$runner" "$CASE/no-such-dir" "$EXP" > "$CASE-out.txt" 2>&1; echo $?)
if [ "$rc" != 0 ] && grep -q 'no such checkout' "$CASE-out.txt"; then
  pass "refuses a missing checkout, naming it"
else
  fail "a missing checkout was accepted, exit $rc: $(out)"
fi

printf '\n%s case(s), %s failure(s)\n' "$case_no" "$failures"
[ "$failures" -eq 0 ] || exit 1
