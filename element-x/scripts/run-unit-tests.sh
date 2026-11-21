#!/usr/bin/env bash
# Runs the Plotina Kotlin/Robolectric unit tests: exactly the classes the patch set adds, in the
# Gradle modules they live in.
#
# Why not `./gradlew test`: the monorepo has 150+ modules and most have nothing to do with our
# patches. Why not the module tasks unfiltered either: an upstream class in the same module can be
# red for a reason that is ours but not this card's (patch 0006 moves the default account provider
# to plotina.cc and upstream's AccountProviderTest asserts matrix.org), and a CI job that is red on
# arrival for an unrelated upstream assertion teaches nobody anything. The classes to run are the
# ones element-x/scripts/test-classes-from-patches.py reads out of the patches.
#
# Usage: run-unit-tests.sh <patched element-x checkout> <expectations file> [gradle args...]
#
# The expectations file is the generator's `--expectations-out`: `<module> <class FQN> <count>`.
# One `./gradlew` invocation per module, each filtered to that module's own classes: `--tests`
# filters are global to an invocation, so one call for all modules would fail on a filter that
# matches nothing in a module.
set -uo pipefail

root="${1:?usage: run-unit-tests.sh <patched element-x checkout> <expectations file> [gradle args]}"
expectations="${2:?usage: run-unit-tests.sh <patched element-x checkout> <expectations file> [gradle args]}"
shift 2

[ -d "$root" ] || { echo "::error::no such checkout: $root" >&2; exit 1; }
[ -f "$expectations" ] || { echo "::error::no such expectations file: $expectations" >&2; exit 1; }

# Module -> unit-test task. `app` has store flavours and its unit tests are flavour-qualified;
# `gplay` is the flavour the shipped APK comes from. Every other module has one debug variant.
gradle_task() {
  case "$1" in
    :app) printf '%s' ':app:testGplayDebugUnitTest' ;;
    *) printf '%s' "${1}:testDebugUnitTest" ;;
  esac
}

modules=$(awk '!/^[[:space:]]*(#|$)/ {print $1}' "$expectations" | sort -u)
[ -n "$modules" ] || { echo "::error::$expectations lists no test classes" >&2; exit 1; }

cd "$root" || exit 1
status=0
for module in $modules; do
  # This module's classes, as `--tests` patterns. The FQN is a Kotlin class name, so a suffix match
  # on the full name is exact (no wildcard needed and none wanted: a wildcard would silently pick
  # up a class the patches did not add).
  args=()
  while read -r fqn; do
    args+=(--tests "$fqn")
  done <<< "$(awk -v m="$module" '!/^[[:space:]]*(#|$)/ && $1 == m {print $2}' "$expectations")"

  task=$(gradle_task "$module")
  echo "== $task (${#args[@]} arg(s), $(( ${#args[@]} / 2 )) class(es))"
  ./gradlew "$task" "${args[@]}" --console=plain "$@"
  rc=$?
  # Do not stop at the first red module: the log should name every module that is red, so one CI
  # run tells the whole story instead of one module per push.
  [ "$rc" -eq 0 ] || { echo "::error::$task failed (exit $rc)"; status=1; }
done

exit "$status"
