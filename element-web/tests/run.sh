#!/usr/bin/env bash
# Unit tests for the Plotina noise-suppression wrappers (Element Web + Cinny).
# Runs every tests/*.test.html and tests/unit.html in headless Chromium and
# fails on any assertion error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$(dirname "$HERE")")"
REL="${HERE#"$ROOT"/}"
PORT="${PORT:-8097}"
CHROME="${CHROME:-chromium}"

# The Element Web Docker build context is element-web/, so the licence and
# notice texts are duplicated there. Keep them byte-identical to the repository
# copies.
cmp "$ROOT/LICENSE" "$ROOT/element-web/LICENSE-AGPL-3.0"
cmp "$ROOT/NOTICE" "$ROOT/element-web/NOTICE"

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/tmp/plotina-noise-tests.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 1

status=0
# A fresh profile per run: with a shared one Chromium served cached copies of
# noise/*.js, so a test could pass against code that was no longer on disk.
PROFILE="$(mktemp -d)"
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$PROFILE"' EXIT
for page in unit.html cinny-ui.test.html; do
  DOM="$("$CHROME" --headless=new --no-sandbox --disable-gpu --virtual-time-budget=5000 \
    --user-data-dir="$PROFILE" --disk-cache-size=1 \
    --dump-dom "http://127.0.0.1:${PORT}/${REL}/${page}" 2>/dev/null)"

  # The inline <script> source contains the marker strings, so read the title only.
  TITLE="$(echo "$DOM" | grep -o '<title>[^<]*</title>' | head -1 | sed 's#</\?title>##g')"
  echo "--- ${page}"
  echo "$DOM" | sed -n '/^PASS\|^FAIL/p'

  case "$TITLE" in
    "TESTS OK")
      echo "    OK"
      ;;
    "TESTS FAILED"*)
      echo "    ${TITLE}"
      status=1
      ;;
    *)
      echo "    harness did not finish (title='${TITLE}')"
      status=1
      ;;
  esac
done

if [ "$status" -ne 0 ]; then
  echo "unit tests: FAILED"
  exit 1
fi
echo "unit tests: OK"
