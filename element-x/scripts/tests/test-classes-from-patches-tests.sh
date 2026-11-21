#!/usr/bin/env bash
# Tests for element-x/scripts/test-classes-from-patches.py.
#
# The generator decides what CI runs: which Gradle modules, which test classes and how many cases
# each must contribute. A generator that quietly finds fewer tests than the patches hold would make
# the CI gate green about a smaller set than the one it was built for, so every case here is about
# what the generator refuses or must not lose.
#
# Run: element-x/scripts/tests/test-classes-from-patches-tests.sh

set -u

here="$(cd "$(dirname "$0")" && pwd)"
scripts_dir="$(dirname "$here")"
gen="$scripts_dir/test-classes-from-patches.py"

work_root="${TMPDIR:-/tmp}/plotina-test-classes-tests.$$"
mkdir -p "$work_root" || exit 2

failures=0
case_no=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

new_case() {
  case_no=$((case_no + 1))
  CASE="$work_root/case$case_no"
  mkdir -p "$CASE/patches"
}

# patch <name> <path> <count>  — a minimal patch that adds <count> @Test cases to one test file.
patch() {
  local name="$1" path="$2" count="$3" i=0
  {
    printf '# Plotina-Patch: fixture\n'
    printf 'diff --git a/%s b/%s\n' "$path" "$path"
    printf -- '--- a/%s\n+++ b/%s\n' "$path" "$path"
    printf '@@ -1,1 +1,%s @@\n' "$((count + 1))"
    printf ' // fixture\n'
    while [ "$i" -lt "$count" ]; do
      printf '+    @Test\n+    fun case%s() {}\n' "$i"
      i=$((i + 1))
    done
  } > "$CASE/patches/$name"
}

run_gen() { python3 "$gen" "$CASE/patches" > "$CASE/out.txt" 2>"$CASE/err.txt"; echo $?; }

# --- case: one patch, one module ------------------------------------------------------
new_case
patch 0001-a.patch "app/src/test/kotlin/io/element/android/x/PlotinaThingTest.kt" 3
rc=$(run_gen)
if [ "$rc" = 0 ] \
   && grep -qx 'TASKS=:app:testGplayDebugUnitTest' "$CASE/out.txt" \
   && grep -q '^:app io.element.android.x.PlotinaThingTest 3$' "$CASE/out.txt"; then
  pass "maps a test file to its Gradle module and counts its @Test cases"
else
  fail "expected ':app ... 3', got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

# --- case: a deep module path keeps its full Gradle path -------------------------------
new_case
patch 0001-a.patch "libraries/matrix/api/src/test/kotlin/io/element/android/api/PlotinaNamesTest.kt" 2
rc=$(run_gen)
if [ "$rc" = 0 ] && grep -qx 'TASKS=:libraries:matrix:api:testDebugUnitTest' "$CASE/out.txt"; then
  pass "keeps the full Gradle path of a nested library module"
else
  fail "expected ':libraries/matrix/api', got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

# --- case: several modules are all listed, once each ----------------------------------
new_case
patch 0001-a.patch "app/src/test/kotlin/io/element/android/x/ATest.kt" 1
patch 0002-b.patch "app/src/test/kotlin/io/element/android/x/BTest.kt" 1
patch 0003-c.patch "features/home/impl/src/test/kotlin/io/element/android/home/CTest.kt" 4
rc=$(run_gen)
if [ "$rc" = 0 ] && [ "$(grep -c 'TASKS=' "$CASE/out.txt")" = 1 ] \
   && grep -qx 'TASKS=:app:testGplayDebugUnitTest :features:home:impl:testDebugUnitTest' "$CASE/out.txt"; then
  pass "lists every module once, sorted, across patches"
else
  fail "expected two deduped modules, got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

# --- case: a class extended by a later patch is not double-counted --------------------
# The patches are cumulative: 0016 adds cases to a class 0015 created. The run executes the final
# file once, so the expectation must be the larger contribution, not the sum.
new_case
patch 0001-a.patch "libraries/matrix/api/src/test/kotlin/io/element/android/api/NTest.kt" 9
patch 0002-b.patch "libraries/matrix/api/src/test/kotlin/io/element/android/api/NTest.kt" 26
rc=$(run_gen)
if [ "$rc" = 0 ] && grep -q '^:libraries:matrix:api io.element.android.api.NTest 26$' "$CASE/out.txt"; then
  pass "takes the largest contribution for a class touched by two patches, not the sum"
else
  fail "expected 26 for the shared class, got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

# --- case: a main-source hunk in the same patch is not a test module -----------------
new_case
{
  printf '# Plotina-Patch: fixture\n'
  printf 'diff --git a/app/src/main/kotlin/io/element/android/x/Thing.kt b/app/src/main/kotlin/io/element/android/x/Thing.kt\n'
  printf -- '--- a/app/src/main/kotlin/io/element/android/x/Thing.kt\n'
  printf '+++ b/app/src/main/kotlin/io/element/android/x/Thing.kt\n'
  printf '@@ -1,2 +1,3 @@\n // main\n+    @Test\n'
  printf 'diff --git a/app/src/test/kotlin/io/element/android/x/ThingTest.kt b/app/src/test/kotlin/io/element/android/x/ThingTest.kt\n'
  printf -- '--- a/app/src/test/kotlin/io/element/android/x/ThingTest.kt\n'
  printf '+++ b/app/src/test/kotlin/io/element/android/x/ThingTest.kt\n'
  printf '@@ -1,1 +1,3 @@\n // test\n+    @Test\n+    fun one() {}\n'
} > "$CASE/patches/0001-a.patch"
rc=$(run_gen)
if [ "$rc" = 0 ] && grep -q '^:app io.element.android.x.ThingTest 1$' "$CASE/out.txt" \
   && grep -qx 'TASKS=:app:testGplayDebugUnitTest' "$CASE/out.txt" \
   && [ "$(grep -c '^:' "$CASE/out.txt")" -eq 1 ]; then
  pass "counts only added @Test in src/test, and only :app is a module"
else
  fail "expected one :app class, got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

# --- case: a @Test the patch removes is not counted ----------------------------------
# A hunk that deletes a case must not inflate the expectation, or the gate would demand a count
# the class can never reach and every run would be red.
new_case
{
  printf '# Plotina-Patch: fixture\n'
  printf 'diff --git a/app/src/test/kotlin/io/element/android/x/ShrunkTest.kt b/app/src/test/kotlin/io/element/android/x/ShrunkTest.kt\n'
  printf -- '--- a/app/src/test/kotlin/io/element/android/x/ShrunkTest.kt\n'
  printf '+++ b/app/src/test/kotlin/io/element/android/x/ShrunkTest.kt\n'
  printf '@@ -1,4 +1,4 @@\n // shrunk\n-    @Test\n-    fun gone() {}\n-    @Test\n+    @Test\n+    fun kept() {}\n'
} > "$CASE/patches/0001-a.patch"
rc=$(run_gen)
if [ "$rc" = 0 ] && grep -q '^:app io.element.android.x.ShrunkTest 1$' "$CASE/out.txt"; then
  pass "counts added @Test lines only, not removed or context ones"
else
  fail "expected 1 for a class that keeps one case and drops another, got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

# --- case: a shared fixture with no @Test is not an expected class -------------------
new_case
patch 0001-a.patch "libraries/matrix/impl/src/test/kotlin/io/element/android/impl/Fixture.kt" 0
rc=$(run_gen)
if [ "$rc" != 0 ] && grep -qi 'adds no @Test' "$CASE/err.txt"; then
  pass "refuses a patch set whose test files carry no @Test cases"
else
  fail "expected a refusal, got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")$(tr '\n' '|' < "$CASE/err.txt")"
fi

# --- case: a deleted test file contributes nothing ----------------------------------
new_case
{
  printf '# Plotina-Patch: fixture\n'
  printf 'diff --git a/app/src/test/kotlin/io/element/android/x/GoneTest.kt b/app/src/test/kotlin/io/element/android/x/GoneTest.kt\n'
  printf 'deleted file mode 100644\n'
  printf -- '--- a/app/src/test/kotlin/io/element/android/x/GoneTest.kt\n'
  printf '+++ /dev/null\n'
  printf '@@ -1,2 +0,0 @@\n-    @Test\n-    fun gone() {}\n'
  printf 'diff --git a/app/src/test/kotlin/io/element/android/x/KeptTest.kt b/app/src/test/kotlin/io/element/android/x/KeptTest.kt\n'
  printf -- '--- a/app/src/test/kotlin/io/element/android/x/KeptTest.kt\n'
  printf '+++ b/app/src/test/kotlin/io/element/android/x/KeptTest.kt\n'
  printf '@@ -1,1 +1,3 @@\n // kept\n+    @Test\n+    fun kept() {}\n'
} > "$CASE/patches/0001-a.patch"
rc=$(run_gen)
if [ "$rc" = 0 ] && grep -q 'KeptTest 1' "$CASE/out.txt" && ! grep -q 'GoneTest' "$CASE/out.txt"; then
  pass "ignores a test file the patch deletes"
else
  fail "expected only KeptTest, got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

# --- case: an empty patches directory is an error, not an empty module list ----------
new_case
rc=$(run_gen)
if [ "$rc" != 0 ] && grep -q 'no .patch files' "$CASE/err.txt"; then
  pass "fails when the patches directory holds no patches"
else
  fail "an empty patches directory was accepted: exit $rc: $(tr '\n' '|' < "$CASE/err.txt")"
fi

# --- case: a missing patches directory is an error ----------------------------------
new_case
rc=$(python3 "$gen" "$CASE/no-such-dir" > "$CASE/out.txt" 2>"$CASE/err.txt"; echo $?)
if [ "$rc" != 0 ]; then
  pass "fails when the patches directory does not exist"
else
  fail "a missing patches directory was accepted"
fi

# --- case: the task list names gplay for the app module and debug for the rest --------
new_case
patch 0001-a.patch "app/src/test/kotlin/io/element/android/x/ATest.kt" 1
patch 0002-b.patch "features/home/impl/src/test/kotlin/io/element/android/home/CTest.kt" 2
rc=$(run_gen)
if [ "$rc" = 0 ] \
   && grep -qx 'TASKS=:app:testGplayDebugUnitTest :features:home:impl:testDebugUnitTest' "$CASE/out.txt"; then
  pass "asks for the gplay unit-test task of app and the debug task of a library"
else
  fail "wrong task list, exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

# --- case: the expectations file the gate reads holds only class lines ---------------
new_case
patch 0001-a.patch "libraries/matrix/api/src/test/kotlin/io/element/android/api/NTest.kt" 2
rc=$(python3 "$gen" "$CASE/patches" \
       --expectations-out "$CASE/expected.txt" --tasks-out "$CASE/tasks.txt" \
       > "$CASE/out.txt" 2>"$CASE/err.txt"; echo $?)
if [ "$rc" = 0 ] \
   && [ "$(cat "$CASE/expected.txt")" = ":libraries:matrix:api io.element.android.api.NTest 2" ] \
   && [ "$(cat "$CASE/tasks.txt")" = ":libraries:matrix:api:testDebugUnitTest" ]; then
  pass "writes the gate's expectations and the Gradle tasks to separate files"
else
  fail "two-file output is wrong, exit $rc: $(tr '\n' '|' < "$CASE/out.txt")$(tr '\n' '|' < "$CASE/err.txt")"
fi

# --- case: a module path fragment is not a module -----------------------------------
# Only `app` sits at the repository root; a single segment like `scripts` is not a Gradle module.
new_case
patch 0001-a.patch "scripts/src/test/kotlin/io/element/android/x/OddTest.kt" 2
patch 0002-b.patch "app/src/test/kotlin/io/element/android/x/RealTest.kt" 1
rc=$(run_gen)
if [ "$rc" = 0 ] && ! grep -q 'scripts' "$CASE/out.txt" && grep -q 'io.element.android.x.RealTest 1' "$CASE/out.txt"; then
  pass "ignores a test path that is not a Gradle module"
else
  fail "expected only the :app class, got exit $rc: $(tr '\n' '|' < "$CASE/out.txt")"
fi

printf '\n%s case(s), %s failure(s)\n' "$case_no" "$failures"
[ "$failures" -eq 0 ] || exit 1
