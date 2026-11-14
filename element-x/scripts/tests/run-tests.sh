#!/usr/bin/env bash
# Tests for the three element-x scripts that decide whether a patch reaches the APK:
#   apply-patches.sh      — applies every patches/*.patch, refuses to finish on a short count
#   check-markers.sh      — looks for each applied patch's marker inside the built APK
#   check-dex-strings.sh  — one literal must be in classes*.dex, another must not be
#
# All are run against throwaway fixtures, so this needs no upstream checkout, no Android SDK
# and no network. Run it with: element-x/scripts/tests/run-tests.sh
#
# Every case prints ok/FAIL; the script exits non-zero if any case failed, which is what makes it
# usable as a CI gate of its own.

set -u

here="$(cd "$(dirname "$0")" && pwd)"
scripts_dir="$(dirname "$here")"
apply_script="$scripts_dir/apply-patches.sh"
gate_script="$scripts_dir/check-markers.sh"
dex_gate_script="$scripts_dir/check-dex-strings.sh"

work_root="${TMPDIR:-/tmp}/plotina-patch-tests.$$"
if ! mkdir -p "$work_root"; then
  echo "cannot create $work_root" >&2
  exit 2
fi

failures=0
case_no=0

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# A fresh fixture tree per case: an "upstream" git checkout plus a client dir holding a copy of
# the script under test and the patch directory it reads (the script resolves patches/ relative
# to itself, so copying the script is enough to point it at the fixture).
new_case() {
  case_no=$((case_no + 1))
  CASE_DIR="$work_root/case$case_no"
  mkdir -p "$CASE_DIR/client/scripts" "$CASE_DIR/client/patches" "$CASE_DIR/upstream"
  cp "$apply_script" "$CASE_DIR/client/scripts/" 2>/dev/null || true
  cp "$gate_script" "$CASE_DIR/client/scripts/" 2>/dev/null || true
  cp "$dex_gate_script" "$CASE_DIR/client/scripts/" 2>/dev/null || true
  printf 'alpha\nbeta\n' > "$CASE_DIR/upstream/a.txt"
  printf 'one\ntwo\n' > "$CASE_DIR/upstream/b.txt"
  git init -q "$CASE_DIR/upstream"
  git -C "$CASE_DIR/upstream" add -A
  git -C "$CASE_DIR/upstream" -c user.email=t@example.invalid -c user.name=test commit -qm init
  MARKERS="$CASE_DIR/plotina-markers.txt"
}

# fixture_patch <file> <marker> <target> <marker-line-position: head|body|none> <body>
# The body is the hunks only; the file/---/+++ headers are built here.
fixture_patch() {
  local file="$1" marker="$2" target="$3" where="$4" body="$5"
  {
    if [ "$where" = head ]; then
      printf '# Plotina-Patch: fixture\n'
      printf '# Plotina-Marker: %s\n' "$marker"
    elif [ "$where" = body ]; then
      printf '# Plotina-Patch: fixture\n'
    fi
    printf 'diff --git a/%s b/%s\n' "$target" "$target"
    printf -- '--- a/%s\n+++ b/%s\n' "$target" "$target"
    printf '%s\n' "$body"
  } > "$file"
}

# run_apply — runs the fixture's apply-patches.sh, capturing stdout+stderr and the exit code.
run_apply() {
  apply_out="$("$CASE_DIR/client/scripts/apply-patches.sh" "$CASE_DIR/upstream" "$MARKERS" 2>&1)"
  apply_rc=$?
}

run_gate() {
  gate_out="$("$CASE_DIR/client/scripts/check-markers.sh" "$CASE_DIR/app.apk" "$MARKERS" 2>&1)"
  gate_rc=$?
}

# run_dex_gate <must-be-present> <must-be-absent>
run_dex_gate() {
  dex_gate_out="$("$CASE_DIR/client/scripts/check-dex-strings.sh" "$CASE_DIR/app.apk" "$1" "$2" 2>&1)"
  dex_gate_rc=$?
}

# fake_apk <path> <dex-text> [<utf16-arsc-text>] — a zip with the entries a real APK has, holding
# the given bytes: enough to exercise the scan without an Android toolchain.
fake_apk() {
  local apk="$1" dex="$2" arsc="${3:-}"
  local stage="$CASE_DIR/apk-stage"
  mkdir -p "$stage/assets/plotina-patches"
  printf '%s\n' "$dex" > "$stage/classes.dex"
  printf '<manifest package="cc.plotina.x"/>' > "$stage/AndroidManifest.xml"
  if [ -n "$arsc" ]; then
    printf '%s' "$arsc" | iconv -f UTF-8 -t UTF-16LE > "$stage/resources.arsc"
  else
    printf 'no strings here' > "$stage/resources.arsc"
  fi
  printf 'stamp\n' > "$stage/assets/plotina-patches/0002.txt"
  rm -f "$apk"
  ( cd "$stage" && zip -q -X "$apk" classes.dex resources.arsc AndroidManifest.xml \
      assets/plotina-patches/0002.txt )
}

# --- apply-patches.sh -----------------------------------------------------------------------------

case_apply_two_patches() {
  new_case
  fixture_patch "$CASE_DIR/client/patches/0002-first.patch" 'gamma' a.txt head \
'@@ -1,2 +1,3 @@
 alpha
+gamma
 beta'
  fixture_patch "$CASE_DIR/client/patches/0004-second.patch" 'deux' b.txt head \
'@@ -1,2 +1,2 @@
 one
-two
+deux'
  run_apply
  local name="apply: both patches land, 2/2, markers written"
  [ "$apply_rc" -eq 0 ] || { fail "$name (exit $apply_rc: $apply_out)"; return; }
  case "$apply_out" in *"applied: 2/2"*) ;; *) fail "$name (no 'applied: 2/2' in output)"; return ;; esac
  case "$apply_out" in *"applied: 0002-first"*) ;; *) fail "$name (no per-patch line)"; return ;; esac
  [ "$(cat "$CASE_DIR/upstream/a.txt")" = "$(printf 'alpha\ngamma\nbeta')" ] \
    || { fail "$name (a.txt not patched)"; return; }
  [ "$(wc -l < "$MARKERS")" -eq 2 ] || { fail "$name (markers file has $(wc -l < "$MARKERS") lines)"; return; }
  grep -qxF "$(printf '0002-first\tgamma')" "$MARKERS" \
    || { fail "$name (marker line for 0002 missing)"; return; }
  pass "$name"
}

case_apply_c_locale_order() {
  new_case
  # '0002-B' and '0002-a' sort differently in LC_ALL=C (B before a) and the same in a
  # case-folding locale: the log line order is the only place the difference shows.
  fixture_patch "$CASE_DIR/client/patches/0002-B.patch" 'UPPER' a.txt head \
'@@ -1,2 +1,3 @@
 alpha
+UPPER
 beta'
  fixture_patch "$CASE_DIR/client/patches/0002-a.patch" 'LOWER' b.txt head \
'@@ -1,2 +1,3 @@
 one
+LOWER
 two'
  # Both fit in either order; only the log line order tells the two apart.
  run_apply
  local name="apply: patches are applied in LC_ALL=C byte order"
  case "$apply_out" in
    *"applied: 0002-B"*"applied: 0002-a"*) pass "$name" ;;
    *) fail "$name (order was: $apply_out)" ;;
  esac
}

case_apply_broken_patch() {
  new_case
  fixture_patch "$CASE_DIR/client/patches/0002-broken.patch" 'eta' a.txt head \
'@@ -9,3 +9,4 @@
 zeta
+eta
 theta'
  fixture_patch "$CASE_DIR/client/patches/0004-fine.patch" 'deux' b.txt head \
'@@ -1,2 +1,2 @@
 one
-two
+deux'
  run_apply
  local name="apply: a patch that does not apply fails the run and is named"
  if [ "$apply_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$apply_out" in *0002-broken*) ;; *) fail "$name (patch not named: $apply_out)"; return ;; esac
  case "$apply_out" in *"does not apply"*) ;; *) fail "$name (no reason given: $apply_out)"; return ;; esac
  [ "$(cat "$CASE_DIR/upstream/b.txt")" = "$(printf 'one\ntwo')" ] \
    || { fail "$name (later patch still applied)"; return; }
  pass "$name"
}

case_apply_missing_marker() {
  new_case
  fixture_patch "$CASE_DIR/client/patches/0002-nomarker.patch" '' a.txt body \
'@@ -1,2 +1,3 @@
 alpha
+gamma
 beta'
  run_apply
  local name="apply: a patch without a marker header is refused"
  if [ "$apply_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$apply_out" in *Plotina-Marker*) ;; *) fail "$name (no marker complaint: $apply_out)"; return ;; esac
  case "$apply_out" in *0002-nomarker*) ;; *) fail "$name (patch not named: $apply_out)"; return ;; esac
  pass "$name"
}

case_apply_marker_absent_from_payload() {
  new_case
  fixture_patch "$CASE_DIR/client/patches/0002-drift.patch" 'token-that-is-not-in-the-hunks' a.txt head \
'@@ -1,2 +1,3 @@
 alpha
+gamma
 beta'
  run_apply
  local name="apply: a marker that the patch itself does not contain is refused"
  if [ "$apply_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$apply_out" in *token-that-is-not-in-the-hunks*) ;; *) fail "$name (token not named: $apply_out)"; return ;; esac
  pass "$name"
}

case_apply_rejects_leftover_rej() {
  new_case
  fixture_patch "$CASE_DIR/client/patches/0002-first.patch" 'gamma' a.txt head \
'@@ -1,2 +1,3 @@
 alpha
+gamma
 beta'
  printf 'leftover\n' > "$CASE_DIR/upstream/b.txt.rej"
  run_apply
  local name="apply: a .rej left in the tree fails the run"
  if [ "$apply_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$apply_out" in *.rej*) ;; *) fail "$name (no .rej complaint: $apply_out)"; return ;; esac
  pass "$name"
}

case_apply_empty_patch_dir() {
  new_case
  run_apply
  local name="apply: no patches at all is an error, not a silent success"
  if [ "$apply_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$apply_out" in *"no *.patch"*) ;; *) fail "$name (no reason given: $apply_out)"; return ;; esac
  pass "$name"
}

# --- check-markers.sh -----------------------------------------------------------------------------

case_gate_all_present() {
  new_case
  printf '0002-first\tplotina-patch-0002\n0004-second\tdeux-token\n' > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'noise plotina-patch-0002 more noise deux-token'
  run_gate
  local name="gate: every marker present passes, 2/2"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  case "$gate_out" in *"2/2"*) ;; *) fail "$name (no 2/2 summary: $gate_out)"; return ;; esac
  pass "$name"
}

case_gate_missing_marker() {
  new_case
  printf '0002-first\tplotina-patch-0002\n0004-second\tdeux-token\n' > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'noise plotina-patch-0002 more noise'
  run_gate
  local name="gate: a missing marker fails and is named"
  if [ "$gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$gate_out" in *deux-token*) ;; *) fail "$name (missing token not named: $gate_out)"; return ;; esac
  case "$gate_out" in *0004-second*) ;; *) fail "$name (patch not named: $gate_out)"; return ;; esac
  case "$gate_out" in *"ok: 0002-first"*) ;; *) fail "$name (present marker not confirmed)"; return ;; esac
  case "$gate_out" in *"ok: 0004-second"*) fail "$name (missing marker reported as ok)"; return ;; esac
  pass "$name"
}

case_gate_utf16_resources() {
  new_case
  printf '0010-strings\tPlotina Call does not support using Bluetooth audio devices\n' > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'nothing here' 'Plotina Call does not support using Bluetooth audio devices'
  run_gate
  local name="gate: markers in UTF-16 resource strings are found (strings -e l)"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  pass "$name"
}

case_gate_not_an_apk() {
  new_case
  printf '0002-first\tplotina-patch-0002\n' > "$MARKERS"
  printf 'not a zip\n' > "$CASE_DIR/app.apk"
  run_gate
  local name="gate: something that is not an APK is refused, not silently passed"
  if [ "$gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$gate_out" in *"could not be read as a zip"*) ;; *) fail "$name (no reason given: $gate_out)"; return ;; esac
  pass "$name"
}

case_gate_empty_markers() {
  new_case
  : > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'noise'
  run_gate
  local name="gate: an empty marker list is an error (a gate that checks nothing is not green)"
  if [ "$gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$gate_out" in *"holds no markers"*) ;; *) fail "$name (no reason given: $gate_out)"; return ;; esac
  pass "$name"
}

# --- check-dex-strings.sh ------------------------------------------------------------------------

case_dex_gate_present_and_absent() {
  new_case
  fake_apk "$CASE_DIR/app.apk" 'noise https://plotina.cc/dl/plotina-purple.png more noise'
  run_dex_gate 'https://plotina.cc/dl/plotina-purple.png' 'https://element.io/mobile-icon.png'
  local name="dex gate: our literal present and Element's absent passes"
  [ "$dex_gate_rc" -eq 0 ] || { fail "$name (exit $dex_gate_rc: $dex_gate_out)"; return; }
  case "$dex_gate_out" in *"is in classes*.dex"*) ;; *) fail "$name (present literal not confirmed)"; return ;; esac
  case "$dex_gate_out" in *"is absent from classes*.dex"*) ;; *) fail "$name (absence not confirmed)"; return ;; esac
  pass "$name"
}

case_dex_gate_surviving_default() {
  new_case
  # The .33 stable APK's shape: Element's default is in the dex no matter what else is there.
  fake_apk "$CASE_DIR/app.apk" 'https://plotina.cc/dl/plotina-purple.png https://element.io/mobile-icon.png'
  run_dex_gate 'https://plotina.cc/dl/plotina-purple.png' 'https://element.io/mobile-icon.png'
  local name="dex gate: a literal that must be absent fails the build when it survived"
  if [ "$dex_gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$dex_gate_out" in *"element.io/mobile-icon.png is still in"*) ;; *) fail "$name (the surviving literal is not named: $dex_gate_out)"; return ;; esac
  case "$dex_gate_out" in *"survived the patch"*) ;; *) fail "$name (not reported as a surviving default: $dex_gate_out)"; return ;; esac
  pass "$name"
}

case_dex_gate_missing_literal() {
  new_case
  fake_apk "$CASE_DIR/app.apk" 'noise only'
  run_dex_gate 'https://plotina.cc/dl/plotina-purple.png' 'https://element.io/mobile-icon.png'
  local name="dex gate: a literal that must be present fails when it is missing"
  if [ "$dex_gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$dex_gate_out" in *"plotina-purple.png is not in any classes*.dex"*) ;; *) fail "$name (no reason given: $dex_gate_out)"; return ;; esac
  pass "$name"
}

case_dex_gate_no_dex() {
  new_case
  printf 'not a zip\n' > "$CASE_DIR/app.apk"
  run_dex_gate 'present-token' 'absent-token'
  local name="dex gate: an artifact with no readable dex is refused, not passed"
  if [ "$dex_gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$dex_gate_out" in *"no readable classes*.dex"*) ;; *) fail "$name (no reason given: $dex_gate_out)"; return ;; esac
  pass "$name"
}

case_apply_two_patches
case_apply_c_locale_order
case_apply_broken_patch
case_apply_missing_marker
case_apply_marker_absent_from_payload
case_apply_rejects_leftover_rej
case_apply_empty_patch_dir
case_gate_all_present
case_gate_missing_marker
case_gate_utf16_resources
case_gate_not_an_apk
case_gate_empty_markers
case_dex_gate_present_and_absent
case_dex_gate_surviving_default
case_dex_gate_missing_literal
case_dex_gate_no_dex

printf '\n%s case(s), %s failure(s)\n' "$case_no" "$failures"
[ "$failures" -eq 0 ]
