#!/usr/bin/env bash
# Tests for scripts/lint-patches.sh — the diff-scoped lint gate.
#
# What these cases pin is the gate's *contract*, not its output format:
#   * it lints what our patches touch, and nothing else — a shell script changed in the tree but not
#     by any patch is not linted, which is what keeps upstream noise out;
#   * it never reports success when it could not run: a missing tool is exit 2 with the tool named,
#     because a gate that silently skips is decoration;
#   * a finding on a line a patch added fails the run (exit 1), a finding on an untouched line of
#     the same patched file does not (exit 0);
#   * it returns non-zero when any stack it ran has a finding of ours.
#
# The tools are stubs written by the cases themselves (a four-line `dart` that prints machine
# output, a `shellcheck` that prints json1), because the point under test is the wiring: which
# files reach which linter, with which arguments, and how the exit code is derived. The real
# linters are exercised by the gate itself in CI and by the negative control in the report.
#
# Run: scripts/tests/lint-patches-test.sh

set -u

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
gate="$repo/scripts/lint-patches.sh"

work_root="$(mktemp -d "${TMPDIR:-/tmp}/plotina-lintgate-tests.XXXXXX")" || exit 2
failures=0
case_no=0

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# new_case — a fixture repository: one client with a patches/ dir, one shell script of ours.
new_case() {
  case_no=$((case_no + 1))
  CASE="$work_root/case$case_no"
  mkdir -p "$CASE/repo/client/patches" "$CASE/repo/client/scripts" "$CASE/bin"
  printf '#!/usr/bin/env bash\necho hello\n' > "$CASE/repo/client/scripts/good.sh"
  printf '#!/usr/bin/env bash\ntrue\n' > "$CASE/repo/client/scripts/other.sh"
  printf 'alpha\nbeta\ngamma\ndelta\n' > "$CASE/repo/client/lib.dart"
  git init -q "$CASE/repo"
  git -C "$CASE/repo" add -A
  git -C "$CASE/repo" -c user.email=t@example.invalid -c user.name=test commit -qm init
}

# stub_shellcheck <exit> <json> — a shellcheck that always prints <json> and exits <exit>.
stub_shellcheck() {
  {
    printf '#!/usr/bin/env bash\n'
    # Record what it was asked to lint, so a case can assert on the file list.
    printf 'printf "%%s\\n" "$@" > "%s/shellcheck-args"\n' "$CASE"
    printf 'cat <<'"'"'JSON'"'"'\n%s\nJSON\n' "$2"
    printf 'exit %s\n' "$1"
  } > "$CASE/bin/shellcheck"
  chmod +x "$CASE/bin/shellcheck"
}

# stub_dart <machine-output> — a `dart` that answers `analyze --format machine` with fixed output.
stub_dart() {
  {
    printf '#!/usr/bin/env bash\n'
    printf 'printf "%%s\\n" "$@" > "%s/dart-args"\n' "$CASE"
    printf 'cat <<'"'"'OUT'"'"'\n%s\nOUT\n' "$1"
  } > "$CASE/bin/dart"
  chmod +x "$CASE/bin/dart"
}

# run_gate [args...] — PATH holds only the stubs and the basics, so no real linter leaks in, and the
# LINT_* overrides are cleared: a runner that exports them (our own CI job does, from the install
# step) would otherwise defeat the "no shellcheck anywhere" case and make the suite pass by accident.
run_gate() {
  out="$(env -u LINT_SHELLCHECK -u LINT_DART -u LINT_ESLINT -u LINT_TS_MODULES \
    -u LINT_TS_ESLINT_MODULE -u LINT_DETEKT -u LINT_DETEKT_CLASSPATH \
    PATH="$CASE/bin:/usr/bin:/bin" "$gate" --repo "$CASE/repo" "$@" 2>&1)"
  rc=$?
}

# --- the contract ----------------------------------------------------------------------------

case_help_lists_the_stacks() {
  new_case
  out="$(PATH="$CASE/bin:/usr/bin:/bin" "$gate" --help 2>&1)"
  rc=$?
  local name="gate: --help exits 0 and names every stack"
  [ "$rc" -eq 0 ] || { fail "$name (exit $rc: $out)"; return; }
  for stack in shell dart ts kotlin; do
    case "$out" in *"$stack"*) ;; *) fail "$name (stack '$stack' missing: $out)"; return ;; esac
  done
  pass "$name"
}

case_unknown_stack_is_refused() {
  new_case
  run_gate --stack cobol
  local name="gate: an unknown stack is refused, not ignored"
  [ "$rc" -eq 2 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *cobol*) ;; *) fail "$name (stack not named: $out)"; return ;; esac
  pass "$name"
}

case_missing_tool_is_an_error_not_a_pass() {
  new_case
  # No shellcheck anywhere — not on PATH and not handed over in LINT_SHELLCHECK, which a runner that
  # exports it (our CI job does) would otherwise supply. The gate must not report "nothing to lint".
  run_gate --stack shell
  local name="gate: a missing linter exits 2 and names it"
  [ "$rc" -eq 2 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *shellcheck*) ;; *) fail "$name (tool not named: $out)"; return ;; esac
  pass "$name"
}

case_clean_shell_passes() {
  new_case
  stub_shellcheck 0 '[]'
  run_gate --stack shell
  local name="gate: no findings is exit 0"
  [ "$rc" -eq 0 ] || { fail "$name (exit $rc: $out)"; return; }
  pass "$name"
}

case_shell_finding_fails() {
  new_case
  stub_shellcheck 1 '[{"file":"REPO/client/scripts/good.sh","line":2,"code":2034,"message":"unused"}]'
  # The stub sees fixture-relative paths; the gate checks exit status and reporting, so give the
  # stub the absolute path the gate will pass by rewriting the placeholder.
  sed -i "s#REPO#$CASE/repo#g" "$CASE/bin/shellcheck"
  run_gate --stack shell
  local name="gate: a shellcheck finding fails the run and is printed"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *SC2034*) ;; *) fail "$name (rule code missing: $out)"; return ;; esac
  pass "$name"
}

case_shell_lints_only_our_scripts() {
  new_case
  stub_shellcheck 0 '[]'
  # A script that appeared in the tree without any patch touching it (an untracked file cannot be
  # "ours" in the diff sense) is not silently linted: the gate reads the tracked set.
  printf '#!/usr/bin/env bash\nrm -rf /\n' > "$CASE/repo/not-ours.sh"
  run_gate --stack shell
  local name="gate: an untracked script is outside the change set"
  [ "$rc" -eq 0 ] || { fail "$name (exit $rc: $out)"; return; }
  if grep -q 'not-ours.sh' "$CASE/shellcheck-args" 2>/dev/null; then
    fail "$name (untracked file was linted)"
    return
  fi
  pass "$name"
}

case_patch_files_drive_the_change_set() {
  new_case
  stub_shellcheck 0 '[]'
  # The gate must read the change set from the patch files, never from `origin/main`: a file
  # changed in the working tree but by no patch is upstream's business, not ours.
  cat > "$CASE/repo/client/patches/0001-touch.patch" << 'PATCH'
# Plotina-Marker: plotina-patch-0001
diff --git a/client/scripts/good.sh b/client/scripts/good.sh
--- a/client/scripts/good.sh
+++ b/client/scripts/good.sh
@@ -1,2 +1,2 @@
 #!/usr/bin/env bash
-echo hello
+echo hello world
PATCH
  run_gate --stack shell
  local name="gate: the change set comes from patches/ and the gate still runs"
  [ "$rc" -eq 0 ] || { fail "$name (exit $rc: $out)"; return; }
  pass "$name"
}

case_dart_needs_a_tree() {
  new_case
  stub_dart ''
  run_gate --stack dart
  local name="gate: the dart stack refuses to run without a patched tree"
  [ "$rc" -eq 2 ] || { fail "$name (exit $rc: $out)"; return; }
  case "$out" in *--tree*) ;; *) fail "$name (missing-tree message absent: $out)"; return ;; esac
  pass "$name"
}

# patched_tree <client> — a fake "applied upstream checkout": two dart files, one of them changed
# by the patch above it, so added-line attribution has something real to work on.
patched_tree() {
  local client="$1"
  TREE="$CASE/tree-$client"
  mkdir -p "$TREE/lib"
  printf 'alpha\nbeta\ngamma\ndelta\n' > "$TREE/lib/lib.dart"
  git init -q "$TREE"
  git -C "$TREE" add -A
  git -C "$TREE" -c user.email=t@example.invalid -c user.name=test commit -qm upstream
  printf 'alpha\nbeta changed\ngamma\ndelta\n' > "$TREE/lib/lib.dart"
}

case_dart_finding_on_our_line_fails() {
  new_case
  patched_tree fluffychat
  stub_dart "$(printf 'INFO|LINT|UNAWAITED_FUTURES|%s/lib/lib.dart|2|3|9|Missing await.' "$CASE/tree-fluffychat")"
  run_gate --stack dart --tree "fluffychat=$CASE/tree-fluffychat"
  local name="gate: a dart finding on a line our patch added fails"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  pass "$name"
}

case_dart_finding_on_upstream_line_passes() {
  new_case
  patched_tree fluffychat
  stub_dart "$(printf 'INFO|LINT|UNAWAITED_FUTURES|%s/lib/lib.dart|4|3|9|Missing await.' "$CASE/tree-fluffychat")"
  run_gate --stack dart --tree "fluffychat=$CASE/tree-fluffychat"
  local name="gate: a dart finding on an untouched line does not fail"
  [ "$rc" -eq 0 ] || { fail "$name (exit $rc: $out)"; return; }
  pass "$name"
}

case_dart_passes_the_files_and_format() {
  new_case
  patched_tree fluffychat
  stub_dart ''
  run_gate --stack dart --tree "fluffychat=$CASE/tree-fluffychat"
  local name="gate: the analyser is asked for machine format and only our files"
  local args
  args="$(cat "$CASE/dart-args" 2>/dev/null)"
  # The stub records one argument per line.
  if ! printf '%s\n' "$args" | grep -qx -- '--format' || \
     ! printf '%s\n' "$args" | grep -qx -- 'machine'; then
    fail "$name (args were: $(printf '%s' "$args" | tr '\n' ' '))"
    return
  fi
  if ! printf '%s\n' "$args" | grep -qx 'lib/lib.dart'; then
    fail "$name (our file not passed: $(printf '%s' "$args" | tr '\n' ' '))"
    return
  fi
  pass "$name"
}

case_one_bad_stack_fails_the_whole_run() {
  new_case
  stub_shellcheck 1 '[{"file":"'"$CASE"'/repo/client/scripts/good.sh","line":2,"code":2164,"message":"cd"}]'
  stub_dart ''
  patched_tree fluffychat
  run_gate --stack shell --stack dart --tree "fluffychat=$CASE/tree-fluffychat"
  local name="gate: one failing stack fails the run even when the other is clean"
  [ "$rc" -eq 1 ] || { fail "$name (exit $rc: $out)"; return; }
  pass "$name"
}

case_help_lists_the_stacks
case_unknown_stack_is_refused
case_missing_tool_is_an_error_not_a_pass
case_clean_shell_passes
case_shell_finding_fails
case_shell_lints_only_our_scripts
case_patch_files_drive_the_change_set
case_dart_needs_a_tree
case_dart_finding_on_our_line_fails
case_dart_finding_on_upstream_line_passes
case_dart_passes_the_files_and_format
case_one_bad_stack_fails_the_whole_run

printf '\n%s case(s), %s failure(s)\n' "$case_no" "$failures"
[ "$failures" -eq 0 ]
