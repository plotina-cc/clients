#!/usr/bin/env bash
# Mutation control for the two test suites next to this one.
#
# A passing test suite is only worth what it refuses. This script copies the scripts directory,
# breaks the code under test on purpose - one defect at a time - and checks that the suite goes red
# for each defect. A mutation that survives means the suite has a hole exactly there, and the
# script exits non-zero so a hole cannot pass as a result.
#
# The mutations run on a copy, never on the tree this script lives in.
#
# Run: element-x/scripts/tests/mutation-control.sh
set -u

here="$(cd "$(dirname "$0")" && pwd)"
client_scripts="$(dirname "$here")"

work_root="${TMPDIR:-/tmp}/plotina-mutation-control.$$"
mkdir -p "$work_root" || exit 2

survivors=0
total=0
report() { printf '%-9s %s\n' "$1" "$2"; }

# mutate <label> <file relative to scripts/> <sed-expression> <test script name>
mutate() {
  local label="$1" rel="$2" expr="$3" test_name="$4"
  total=$((total + 1))
  local copy="$work_root/mut$total"
  mkdir -p "$copy"
  cp -a "$client_scripts" "$copy/scripts"
  local target="$copy/scripts/$rel"
  local before after
  before=$(sha256sum "$target" | cut -d' ' -f1)
  sed -i "$expr" "$target"
  after=$(sha256sum "$target" | cut -d' ' -f1)
  if [ "$before" = "$after" ]; then
    report "ERROR" "$label: the sed expression changed nothing, so the control proves nothing"
    survivors=$((survivors + 1))
    return
  fi
  if "$copy/scripts/tests/$test_name" > "$copy/out.txt" 2>&1; then
    report "SURVIVED" "$label - the suite stayed green with this defect in place"
    survivors=$((survivors + 1))
  else
    report "killed" "$label"
    grep -m1 '^FAIL' "$copy/out.txt" | sed 's/^ */          /' || true
  fi
}

# --- the generator: what CI runs, and how much ------------------------------------------
mutate "generator: lists only one module of a multi-module patch set" \
  test-classes-from-patches.py 's|modules = sorted({module for module, _ in classes})|modules = sorted({list(classes)[0][0]})|' \
  test-classes-from-patches-tests.sh

mutate "generator: sums a shared class instead of taking the largest patch" \
  test-classes-from-patches.py 's|best\[key\] = max(best.get(key, 0), n)|best[key] = best.get(key, 0) + n|' \
  test-classes-from-patches-tests.sh

mutate "generator: reports a module that has no @Test cases" \
  test-classes-from-patches.py 's|classes = {key: n for key, n in best.items() if n > 0}|classes = dict(best)|' \
  test-classes-from-patches-tests.sh

mutate "generator: counts a removed @Test as an added one" \
  test-classes-from-patches.py 's|^ADDED_TEST = re.compile(r"^\\+\\s\*@Test\\b")$|ADDED_TEST = re.compile(r"^[+\\-]\\s*@Test\\b")|' \
  test-classes-from-patches-tests.sh

mutate "generator: accepts an empty patches directory" \
  test-classes-from-patches.py 's|^    if not files:$|    if False:|' \
  test-classes-from-patches-tests.sh

# --- the results gate: what it refuses --------------------------------------------------
mutate "gate: passes a short class (the count check is off)" \
  check-test-results.sh 's|if \[ "$seen" -lt "$want" \]; then|if false; then|' \
  check-test-results-tests.sh

mutate "gate: passes a class that left no XML behind" \
  check-test-results.sh 's|if \[ "$found" -eq 0 \]; then|if false; then|' \
  check-test-results-tests.sh

mutate "gate: ignores failures recorded in the XML" \
  check-test-results.sh 's|if \[ "$failures" -ne 0 \] \|\| \[ "$errors" -ne 0 \]; then|if false; then|' \
  check-test-results-tests.sh

mutate "gate: passes an empty expectations file" \
  check-test-results.sh 's|if \[ "${#lines\[@\]}" -eq 0 \]; then|if false; then|' \
  check-test-results-tests.sh

mutate "gate: does not require the expectations file to exist" \
  check-test-results.sh 's|^\[ -f "$expected_file" \].*$|true|' \
  check-test-results-tests.sh

mutate "gate: does not require the checkout root to exist" \
  check-test-results.sh 's|^\[ -d "$root" \].*$|true|' \
  check-test-results-tests.sh

# --- the runner: what it asks Gradle for ------------------------------------------------
mutate "runner: asks for the whole module instead of the Plotina classes" \
  run-unit-tests.sh 's|^  ./gradlew "\$task" "\${args\[@\]}".*$|  ./gradlew "$task" --console=plain "$@"|' \
  run-unit-tests-tests.sh

mutate "runner: asks for a bare 'test' task" \
  run-unit-tests.sh 's|^    \*) printf .%s. "\${1}:testDebugUnitTest" ;;$|    *) printf "%s" "test" ;;|' \
  run-unit-tests-tests.sh

mutate "runner: filters with a wildcard instead of the exact FQN" \
  run-unit-tests.sh 's|args+=(--tests "\$fqn")|args+=(--tests "*$fqn*")|' \
  run-unit-tests-tests.sh

mutate "runner: stops at the first red module" \
  run-unit-tests.sh 's|^  \[ "\$rc" -eq 0 \] \|\| { echo "::error::\$task failed (exit \$rc)"; status=1; }$|  [ "$rc" -eq 0 ] \|\| { echo "::error::$task failed (exit $rc)"; exit "$rc"; }|' \
  run-unit-tests-tests.sh

mutate "runner: accepts an empty expectations file" \
  run-unit-tests.sh 's|^\[ -n "\$modules" \] \|\| .*$|true|' \
  run-unit-tests-tests.sh

mutate "runner: does not require the expectations file to exist" \
  run-unit-tests.sh 's|^\[ -f "\$expectations" \].*$|true|' \
  run-unit-tests-tests.sh

printf '\n%s mutation(s), %s survivor(s)\n' "$total" "$survivors"
[ "$survivors" -eq 0 ] || exit 1
