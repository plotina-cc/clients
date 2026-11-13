#!/usr/bin/env bash
# Tests for the two repository-wide scripts that decide whether a Plotina patch reaches an
# artifact, used by cinny, fluffychat and element-call:
#   scripts/apply-patches.sh <client-dir> <upstream-dir> [markers-file]
#   scripts/check-markers.sh <artifact> <markers-file>
#
# Both run against throwaway fixtures: no upstream clone, no toolchain, no network. Run it with
# scripts/tests/run-tests.sh — every case prints ok/FAIL and the script exits non-zero if any case
# failed, which is what makes it usable as a gate of its own.
#
# The artifact gate is checked against the artifact shapes the three clients really produce:
# a directory (cinny's web dist, element-call's unpacked bundle), a zip (an APK), a tar.gz and a
# plain file (an app.asar), because a gate that only understands one shape gets skipped elsewhere.

set -u

here="$(cd "$(dirname "$0")" && pwd)"
scripts_dir="$(dirname "$here")"
apply_script="$scripts_dir/apply-patches.sh"
gate_script="$scripts_dir/check-markers.sh"

work_root="$(mktemp -d "${TMPDIR:-/tmp}/plotina-rollout-tests.XXXXXX")"
if [ ! -d "$work_root" ]; then
  echo "cannot create a work root" >&2
  exit 2
fi

failures=0
case_no=0

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }

# A fresh fixture per case: an "upstream" git checkout plus a client dir holding only the patch
# directory the apply script reads.
new_case() {
  case_no=$((case_no + 1))
  CASE_DIR="$work_root/case$case_no"
  mkdir -p "$CASE_DIR/client/patches" "$CASE_DIR/upstream"
  printf 'alpha\nbeta\n' > "$CASE_DIR/upstream/a.txt"
  printf 'one\ntwo\n' > "$CASE_DIR/upstream/b.txt"
  git init -q "$CASE_DIR/upstream"
  git -C "$CASE_DIR/upstream" add -A
  git -C "$CASE_DIR/upstream" -c user.email=t@example.invalid -c user.name=test commit -qm init
  MARKERS="$CASE_DIR/plotina-markers.txt"
}

# fixture_patch <file> <marker> <target> <marker-line-position: head|body|none> <body>
# Only the hunks are passed in; the file/---/+++ headers are built here.
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

# run_apply [client-dir] — runs apply-patches.sh, capturing stdout+stderr and the exit code.
run_apply() {
  local client="${1:-$CASE_DIR/client}"
  apply_out="$("$apply_script" "$client" "$CASE_DIR/upstream" "$MARKERS" 2>&1)"
  apply_rc=$?
}

# run_gate <artifact> — runs check-markers.sh, capturing stdout+stderr and the exit code.
run_gate() {
  gate_out="$("$gate_script" "$1" "$MARKERS" 2>&1)"
  gate_rc=$?
}

# fake_apk <path> <dex-text> [<utf16-arsc-text>] — a zip with the entries a real APK has.
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
  ( cd "$stage" && zip -q -X -r "$apk" . )
}

# fake_web_dist <dir> <assets-text> — what a minified web build looks like: JS in assets/.
fake_web_dist() {
  local dir="$1" text="$2"
  mkdir -p "$dir/assets"
  printf '<!doctype html><title>t</title>\n' > "$dir/index.html"
  printf '#!/usr/bin/env node\nconst s=%s;\n' "\"$text\"" > "$dir/assets/index-abc123.js"
  printf '{"name":"x"}' > "$dir/manifest.webmanifest"
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
  # '0002-B' and '0002-a' sort differently in LC_ALL=C (B before a) but alike in a case-folding
  # locale: the log line order is the only place the difference shows.
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

case_apply_missing_client_patches_dir() {
  new_case
  # A client dir without patches/ is a wiring mistake (wrong path in the workflow), not "0 patches".
  local name="apply: a client dir without patches/ is refused"
  mkdir -p "$CASE_DIR/other-client"
  run_apply "$CASE_DIR/other-client"
  if [ "$apply_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$apply_out" in *"no patches/ directory"*) ;; *) fail "$name (patches dir not named: $apply_out)"; return ;; esac
  pass "$name"
}

case_apply_ignores_patches_in_upstream() {
  new_case
  # The patch set belongs to the client dir. A stray .patch inside the upstream checkout (an
  # upstream release tarball can carry one) must not enter the count.
  cp /dev/null "$CASE_DIR/upstream/stray.patch"
  fixture_patch "$CASE_DIR/client/patches/0002-only.patch" 'gamma' a.txt head \
'@@ -1,2 +1,3 @@
 alpha
+gamma
 beta'
  run_apply
  local name="apply: only <client-dir>/patches is applied, never patches inside the upstream tree"
  [ "$apply_rc" -eq 0 ] || { fail "$name (exit $apply_rc: $apply_out)"; return; }
  case "$apply_out" in *"applied: 1/1"*) pass "$name" ;;
    *) fail "$name (count was: $apply_out)" ;;
  esac
}

# --- check-markers.sh -----------------------------------------------------------------------------

case_gate_apk_all_present() {
  new_case
  printf '0002-first\tplotina-patch-0002\n0004-second\tdeux-token\n' > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'noise plotina-patch-0002 more noise deux-token'
  run_gate "$CASE_DIR/app.apk"
  local name="gate: an APK with every marker passes, 2/2"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  case "$gate_out" in *"2/2"*) ;; *) fail "$name (no 2/2 summary: $gate_out)"; return ;; esac
  pass "$name"
}

case_gate_apk_missing_marker() {
  new_case
  printf '0002-first\tplotina-patch-0002\n0004-second\tdeux-token\n' > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'noise plotina-patch-0002 more noise'
  run_gate "$CASE_DIR/app.apk"
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
  run_gate "$CASE_DIR/app.apk"
  local name="gate: markers in UTF-16 resource strings are found (strings -e l)"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  pass "$name"
}

case_gate_web_dist_dir() {
  new_case
  printf '0007-sso\tplotina:sso:login-token\n0008-updates\tplotina-updates-page\n' > "$MARKERS"
  fake_web_dist "$CASE_DIR/dist" 'plotina:sso:login-token and plotina-updates-page'
  run_gate "$CASE_DIR/dist"
  local name="gate: a built web dist directory is scanned, 2/2"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  case "$gate_out" in *"2/2"*) ;; *) fail "$name (no 2/2 summary: $gate_out)"; return ;; esac
  pass "$name"
}

case_gate_web_dist_dir_missing() {
  new_case
  printf '0007-sso\tplotina:sso:login-token\n0009-noise\tplotina-noise-settings\n' > "$MARKERS"
  fake_web_dist "$CASE_DIR/dist" 'plotina:sso:login-token only'
  run_gate "$CASE_DIR/dist"
  local name="gate: a web dist missing one marker fails and names it"
  if [ "$gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$gate_out" in *plotina-noise-settings*) ;; *) fail "$name (token not named: $gate_out)"; return ;; esac
  pass "$name"
}

case_gate_tar_gz() {
  new_case
  printf '0003-branding\tPlotina Call\n' > "$MARKERS"
  fake_web_dist "$CASE_DIR/bundle" 'the title is Plotina Call'
  tar -C "$CASE_DIR" -czf "$CASE_DIR/bundle.tar.gz" bundle
  run_gate "$CASE_DIR/bundle.tar.gz"
  local name="gate: a tar.gz bundle is scanned"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  pass "$name"
}

case_gate_plain_file() {
  new_case
  printf '0001-sentry\tplotina:sentry:dsn\n' > "$MARKERS"
  printf '{"files":{}}\nconst dsn="plotina:sentry:dsn";\n' > "$CASE_DIR/app.asar"
  run_gate "$CASE_DIR/app.asar"
  local name="gate: a plain binary file (app.asar) is scanned"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  pass "$name"
}

case_gate_broken_archive() {
  new_case
  printf '0002-first\tplotina-patch-0002\n' > "$MARKERS"
  printf 'PK\003\004not really a zip\n' > "$CASE_DIR/app.apk"
  run_gate "$CASE_DIR/app.apk"
  local name="gate: an artifact that cannot be read is refused, not silently passed"
  if [ "$gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$gate_out" in *"could not be read"*) ;; *) fail "$name (no reason given: $gate_out)"; return ;; esac
  pass "$name"
}

case_gate_missing_artifact() {
  new_case
  printf '0002-first\tplotina-patch-0002\n' > "$MARKERS"
  run_gate "$CASE_DIR/absent.apk"
  local name="gate: a missing artifact is an error"
  if [ "$gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$gate_out" in *"no artifact"*) ;; *) fail "$name (no reason given: $gate_out)"; return ;; esac
  pass "$name"
}

case_gate_empty_markers() {
  new_case
  : > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'noise'
  run_gate "$CASE_DIR/app.apk"
  local name="gate: an empty marker list is an error (a gate that checks nothing is not green)"
  if [ "$gate_rc" -eq 0 ]; then fail "$name (exit 0)"; return; fi
  case "$gate_out" in *"holds no markers"*) ;; *) fail "$name (no reason given: $gate_out)"; return ;; esac
  pass "$name"
}

case_gate_non_ascii_marker() {
  new_case
  # A marker can be a Russian UI string or carry an emoji. `strings` with the C locale stops at the
  # first non-ASCII byte, so a gate that only greps its output cannot see these — and a marker the
  # gate cannot see is a patch nobody verifies.
  printf '0018-donations\tСпасибо, что пользуетесь Plotina Mobile.\n0011-strings\t💬 Новое сообщение в Plotina Mobile\n' > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'noise Спасибо, что пользуетесь Plotina Mobile. more noise 💬 Новое сообщение в Plotina Mobile'
  run_gate "$CASE_DIR/app.apk"
  local name="gate: a non-ASCII marker is found in the APK (raw byte search)"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  pass "$name"
}

case_gate_utf16_non_ascii() {
  new_case
  # The same string inside a UTF-16LE resource table (resources.arsc) — the shape a translated
  # Android string takes.
  printf '0018-donations\tСпасибо, что пользуетесь Plotina Mobile.\n' > "$MARKERS"
  fake_apk "$CASE_DIR/app.apk" 'nothing here' 'Спасибо, что пользуетесь Plotina Mobile.'
  run_gate "$CASE_DIR/app.apk"
  local name="gate: a non-ASCII marker in UTF-16 resources is found"
  [ "$gate_rc" -eq 0 ] || { fail "$name (exit $gate_rc: $gate_out)"; return; }
  pass "$name"
}

case_apply_two_patches
case_apply_c_locale_order
case_apply_broken_patch
case_apply_missing_marker
case_apply_marker_absent_from_payload
case_apply_rejects_leftover_rej
case_apply_empty_patch_dir
case_apply_missing_client_patches_dir
case_apply_ignores_patches_in_upstream
case_gate_apk_all_present
case_gate_apk_missing_marker
case_gate_utf16_resources
case_gate_web_dist_dir
case_gate_web_dist_dir_missing
case_gate_tar_gz
case_gate_plain_file
case_gate_broken_archive
case_gate_missing_artifact
case_gate_empty_markers
case_gate_non_ascii_marker
case_gate_utf16_non_ascii

printf '\n%s case(s), %s failure(s)\n' "$case_no" "$failures"
[ "$failures" -eq 0 ]
