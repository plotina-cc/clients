#!/usr/bin/env bash
# Gate: every Plotina test class really ran, and ran as many tests as it should.
#
# Gradle is allowed to be green about a test task that executed nothing. A filter that matches no
# class, a source set that moved, a `--tests` pattern that stopped matching after an upstream bump:
# all of them produce BUILD SUCCESSFUL with an empty (or short) test-results directory, so a CI
# step whose only signal is Gradle's exit code says nothing about whether our tests ran at all.
# This script reads the JUnit XML the tasks actually wrote and fails when a class we expect is
# missing or contributed fewer tests than it did when the patch was written.
#
# Usage: check-test-results.sh <element-x checkout> <expectations file>
#
# The expectations file is one line per test class:
#   <gradle module path> <test class FQN> <expected test count>
# generated from the patch set by element-x/scripts/test-classes-from-patches.py, so a new test
# in a new patch shows up here without anyone editing a list by hand.
#
# Exits 0 only when every expected class is present with at least its count and none of them
# reports a failure or an error.

set -uo pipefail

root="${1:?usage: check-test-results.sh <element-x checkout> <expectations file>}"
expected_file="${2:?usage: check-test-results.sh <element-x checkout> <expectations file>}"

[ -d "$root" ] || { echo "::error::no such checkout: $root" >&2; exit 1; }
[ -f "$expected_file" ] || { echo "::error::no such expectations file: $expected_file" >&2; exit 1; }

# Only lines with three fields count; the generator writes comments, and a hand-edit may too.
mapfile -t lines < <(grep -Ev '^[[:space:]]*(#|$)' "$expected_file")
if [ "${#lines[@]}" -eq 0 ]; then
  echo "::error::$expected_file lists no test classes: the gate would pass vacuously" >&2
  exit 1
fi

total_seen=0
total_expected=0
failed=0

printf '%-58s %6s %6s\n' "test class" "ran" "want"
for line in "${lines[@]}"; do
  # shellcheck disable=SC2086 # three whitespace-separated fields, no quoting wanted
  read -r module class want <<< "$line"
  case "$module" in
    :*) ;;
    *) echo "::error::'$module' in $expected_file is not a Gradle module path (it must start with ':')" >&2; failed=1; continue ;;
  esac
  case "$want" in
    ''|*[!0-9]*) echo "::error::'$want' for $class in $expected_file is not a test count" >&2; failed=1; continue ;;
  esac

  # The module's path on disk is its Gradle path with the colons flattened; test-results holds one
  # directory per test task, and the app module writes one per flavour (`testGplayDebugUnitTest`).
  rel="${module#:}"
  rel="${rel//://}"
  seen=0
  failures=0
  errors=0
  found=0
  for xml in "$root/$rel"/build/test-results/*/"TEST-$class.xml"; do
    [ -f "$xml" ] || continue
    found=1
    # `tests="N"` is what the task executed; the attribute is the only stable count in the file.
    n=$(sed -n 's/.*<testsuite[^>]* tests="\([0-9]*\)".*/\1/p' "$xml" | head -1)
    f=$(sed -n 's/.*<testsuite[^>]* failures="\([0-9]*\)".*/\1/p' "$xml" | head -1)
    e=$(sed -n 's/.*<testsuite[^>]* errors="\([0-9]*\)".*/\1/p' "$xml" | head -1)
    seen=$((seen + ${n:-0}))
    failures=$((failures + ${f:-0}))
    errors=$((errors + ${e:-0}))
  done

  if [ "$found" -eq 0 ]; then
    printf '%-58s %6s %6s\n' "$class" "-" "$want"
    echo "::error::no result for $class in $module: the test task did not produce TEST-$class.xml"
    failed=1
    continue
  fi

  printf '%-58s %6s %6s\n' "$class" "$seen" "$want"
  total_seen=$((total_seen + seen))
  total_expected=$((total_expected + want))

  # A count below the expectation is a test that stopped running - a deleted case, or one that
  # silently stopped being collected. More than expected is fine: a patch may add cases.
  if [ "$seen" -lt "$want" ]; then
    echo "::error::$class ran $seen of $want tests: $((want - seen)) did not run"
    failed=1
  fi
  if [ "$failures" -ne 0 ] || [ "$errors" -ne 0 ]; then
    echo "::error::$class reports $failures failure(s) and $errors error(s) in its JUnit XML"
    failed=1
  fi
done

echo
echo "expected classes: ${#lines[@]}; $total_seen test(s) ran against an expectation of $total_expected"
if [ "$failed" -ne 0 ]; then
  echo "::error::the Plotina unit tests did not all run: see the lines above"
  exit 1
fi
echo "OK: every expected Plotina test class ran with at least its expected count"
