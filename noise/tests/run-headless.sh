#!/usr/bin/env bash
# Headless Chromium smoke for the selectable noise backend: selector wiring
# (browser-ui.test.html, plain and with the URL override) and the real DPDFNet
# module in a browser (dpdfnet-infer.test.html). Model + ort assets must be
# fetched first: python3 noise/scripts/fetch-dpdfnet.py
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$(dirname "$HERE")")"
PORT="${PORT:-8099}"
CHROME="${CHROME:-chromium}"
# The infer page compiles a 15 MB wasm binary and runs 30 ONNX frames; the
# virtual-time budget is a ceiling, not a wait.
BUDGET="${BUDGET:-120000}"

if [ ! -f "$HERE/../vendor/dpdfnet/dpdfnet2_48khz_hr/model_stateful.onnx" ]; then
  echo "run-headless: model assets not fetched — python3 noise/scripts/fetch-dpdfnet.py" >&2
  exit 2
fi

python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT" >/tmp/plotina-dpdfnet-tests.log 2>&1 &
SERVER_PID=$!
PROFILE="$(mktemp -d)"
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -rf "$PROFILE"' EXIT
sleep 1

status=0
run_page() { # url  budget  expect-title-regex
  local url="$1" budget="$2"
  local dom title
  dom="$("$CHROME" --headless=new --no-sandbox --disable-gpu --enable-features=AudioServiceOutOfProcess \
    --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
    --virtual-time-budget="$budget" \
    --user-data-dir="$PROFILE" --disk-cache-size=1 --disable-dev-shm-usage \
    --dump-dom "$url" 2>/dev/null || true)"
  title="$(echo "$dom" | grep -o '<title>[^<]*</title>' | head -1 | sed 's#</\?title>##g')"
  echo "--- $url"
  echo "$dom" | grep -E '^(PASS|FAIL|session|frames=|module|loading)' | head -8
  case "$title" in
    "TESTS OK") echo "    OK" ;;
    *) echo "    harness did not finish (title='${title}')"; status=1 ;;
  esac
}

run_page "http://127.0.0.1:${PORT}/noise/tests/browser-ui.test.html" 8000
run_page "http://127.0.0.1:${PORT}/noise/tests/browser-ui.test.html?plotina-backend=dpdfnet4" 8000
run_page "http://127.0.0.1:${PORT}/noise/tests/dpdfnet-infer.test.html" "$BUDGET"

if [ "$status" -ne 0 ]; then echo "dpdfnet headless: FAILED"; exit 1; fi
echo "dpdfnet headless: OK"
