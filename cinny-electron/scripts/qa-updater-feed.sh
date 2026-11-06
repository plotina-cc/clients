#!/usr/bin/env bash
# U2/U4 behaviour proof for the packaged updater against a QA local feed
# (PLOTINA_QA_UPDATES=1 + PLOTINA_UPDATE_FEED_URL, src/updater.js). Needs a
# built dist/ AppImage + linux-unpacked. Never touches the GitHub feed.
#
#   bash scripts/qa-updater-feed.sh        (KEEP=1 keeps logs on failure)
#
# U2: feed advertises a NEWER version whose bytes match the running image ->
#     updater downloads, verifies sha512, atomically renames over $APPIMAGE
#     (inode changes, staged file gone), reports state=downloaded.
# U4: feed advertises a newer version with a CORRUPT sha512 -> updater
#     refuses, deletes the .part, running image untouched, state=error.
#
# The feed server binds an OS-chosen FREE port (a fixed port silently
# re-anchored an interrupted earlier run's stale directory during testing).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mktemp -d)"
SERVER=""
cleanup() { [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null; [ "${KEEP:-0}" = 1 ] || rm -rf "$OUT"; }
trap cleanup EXIT
mkdir -p "$OUT/feed" "$OUT/profile"
BIN="$HERE/dist/linux-unpacked/plotina-lite-desktop"
AI=$(ls "$HERE"/dist/*.AppImage | head -1)
NAME=$(basename "$AI")
[ -x "$BIN" ] && [ -f "$AI" ] || { echo "build dist/ first (build-packages.sh linux)" >&2; exit 1; }
ln "$AI" "$OUT/feed/$NAME"
sha512_b64() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }

PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
(cd "$OUT/feed" && exec python3 -m http.server "$PORT" -b 127.0.0.1 >/dev/null 2>&1) & SERVER=$!
sleep 1
kill -0 "$SERVER" || { echo "feed server failed to start" >&2; exit 1; }
FEED="http://127.0.0.1:$PORT/"
echo "feed: $FEED"

run_app() { # $1=logfile $2=port
  APPIMAGE="$AI" LITE_USER_DATA="$OUT/profile" PLOTINA_QA_UPDATES=1 \
  PLOTINA_UPDATE_FEED_URL="$FEED" LITE_PORT="$2" \
  timeout 70 xvfb-run -a -s "-screen 0 1280x800x24" "$BIN" --no-first-run >"$1" 2>&1
}

# --- U2: honest metadata, swapped-in identical bytes
cat > "$OUT/feed/latest-linux.yml" <<EOF
version: 4.12.8-plotina.9999
files:
  - url: $NAME
    sha512: $(sha512_b64 "$OUT/feed/$NAME")
    size: $(stat -c %s "$OUT/feed/$NAME")
path: $NAME
sha512: $(sha512_b64 "$OUT/feed/$NAME")
releaseDate: '2026-12-01T00:00:00.000Z'
EOF
BEFORE_INODE=$(stat -c %i "$AI")
run_app "$OUT/u2.log" 44573
grep -E '\[updater\]' "$OUT/u2.log"
[ -s "$OUT/u2.log" ] || { echo "FAIL: no updater output"; exit 1; }
grep -q '"state":"downloaded"' "$OUT/u2.log" || { echo "FAIL U2: swap not reported"; exit 1; }
AFTER_INODE=$(stat -c %i "$AI")
[ "$BEFORE_INODE" != "$AFTER_INODE" ] || { echo "FAIL U2: AppImage inode unchanged"; exit 1; }
ls "$HERE"/dist/*.plotina-new >/dev/null 2>&1 && { echo "FAIL U2: staged file left behind"; exit 1; }
echo "U2 OK (swap verified: inode $BEFORE_INODE -> $AFTER_INODE, staged cleaned)"

# --- U4: corrupt sha512 -> refuse, leave image untouched
cat > "$OUT/feed/latest-linux.yml" <<EOF
version: 4.12.8-plotina.9998
files:
  - url: $NAME
    sha512: AAAA${RANDOM}${RANDOM}${RANDOM}
    size: $(stat -c %s "$OUT/feed/$NAME")
path: $NAME
sha512: not-a-valid-sha-at-all-${RANDOM}
releaseDate: '2026-12-01T00:00:00.000Z'
EOF
run_app "$OUT/u4.log" 44574
grep -E '\[updater\]' "$OUT/u4.log"
grep -q 'sha512 mismatch' "$OUT/u4.log" || { echo "FAIL U4: mismatch not detected"; exit 1; }
grep -q '"state":"error"' "$OUT/u4.log" || { echo "FAIL U4: error state missing"; exit 1; }
ls "$HERE"/dist/*.plotina-new.part "$HERE"/dist/*.plotina-new >/dev/null 2>&1 && { echo "FAIL U4: partial staged file left"; exit 1; }
echo "U4 OK (corrupt sha refused; running image untouched)"
[ "${KEEP:-0}" = 1 ] && echo "run dir kept: $OUT" || true
