#!/usr/bin/env bash
# qa-dev-channel.sh — proof of the two update channels on the packaged app
# against a LOCAL feed directory. Nothing is published and nothing leaves this
# machine; the feed layout is exactly a GitHub release (metadata + artifacts in
# one directory), so the code paths under test are the production ones.
#
# Build the images first, then:
#   bash scripts/build-appimages.sh
#   bash scripts/qa-dev-channel.sh          (KEEP=1 keeps logs + .qa/run)
#
# Cases (runner = unpacked binary of that version, APPIMAGE = a private copy of
# the matching image, same trick as scripts/qa-updater-feed.sh — no FUSE):
#   A  stable channel, stable install   -> reads latest-linux.yml only, verifies
#      sha512, atomically swaps in the newer stable image.
#   B  dev channel, stable install      -> reads latest-linux-dev.yml only,
#      swaps in the dev build (19-dev.1 sorts above 19).
#   C  dev channel through LITE_DEV_FEED_URL, no QA override -> the production
#      URL shape (<base>/latest-linux-dev.yml) is fetched and installed.
#   D  dev install on the STABLE channel with a feed advertising a LOWER stable
#      version -> refused: no download, no swap. A reduction is only ever
#      applied by the explicit 'Вернуться на стабильный' action, which is
#      interactive (menu) and covered by tests/updater-channel-flow.test.mjs F4.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"
QA="$HERE/.qa"; IMAGES="$QA/images"; UNPACKED="$QA/unpacked"; RUNDIR="$QA/run"; LOGDIR="$QA/logs"
FEED_URL_BASE=""
rm -rf "$RUNDIR" "$LOGDIR" "$QA/feed"; mkdir -p "$RUNDIR" "$LOGDIR" "$QA/feed"
Srv=""
stop_server() { [ -n "$Srv" ] && kill "$Srv" 2>/dev/null; Srv=""; }
cleanup() { stop_server; [ "${KEEP:-0}" = 1 ] || { stop_server; }; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; echo "logs kept under $LOGDIR (KEEP=1 keeps $RUNDIR too)" >&2; exit 1; }

for f in 4.12.8-plotina.19 4.12.8-plotina.20 4.12.8-plotina.19-dev.1; do
  [ -f "$IMAGES/Plotina-Lite-Desktop-$f-x86_64.AppImage" ] || fail "missing $IMAGES/Plotina-Lite-Desktop-$f-x86_64.AppImage (run scripts/build-appimages.sh)"
  [ -x "$UNPACKED/$f/plotina-lite-desktop" ] || fail "missing $UNPACKED/$f/plotina-lite-desktop"
done

sha512_b64() { openssl dgst -sha512 -binary "$1" | openssl base64 -A; }
write_yml() { # $1=metadata name $2=version $3=artifact (absolute or relative to images/)
  local name; name="$(basename "$3")"
  cp -f "$3" "$QA/feed/$name"
  cat > "$QA/feed/$1" <<EOF
version: $2
files:
  - url: $name
    sha512: $(sha512_b64 "$3")
    size: $(stat -c %s "$3")
    blockMapSize: 154509
path: $name
sha512: $(sha512_b64 "$3")
releaseDate: '2026-11-07T10:00:00.000Z'
EOF
}
# dev-latest/: the same layout under the subdirectory the GitHub dev release
# would use, for case C.
mkdir -p "$QA/feed/dev-latest"

start_server() { # $1 = access log
  PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  ( cd "$QA/feed" && exec python3 -m http.server "$PORT" -b 127.0.0.1 >>"$1" 2>&1 ) & Srv=$!
  sleep 1
  kill -0 "$Srv" || fail "feed server failed to start"
  FEED_URL_BASE="http://127.0.0.1:$PORT/"
  echo "  feed: $FEED_URL_BASE (log $1)"
}

run_case() { # $1=name $2=runner version $3=image version $4=channel $5=qa-override $6=dev-feed-url-suffix $7=marker $8=max-wait
  local name=$1 runver=$2 imgver=$3 chan=$4 qa=$5 devsub=$6 marker=$7 maxwait=$8
  local img="$RUNDIR/Plotina-Lite-Desktop-$imgver-x86_64.AppImage"
  cp -f "$IMAGES/Plotina-Lite-Desktop-$imgver-x86_64.AppImage" "$img" && chmod +x "$img"
  local log="$LOGDIR/$name.log"
  start_server "$LOGDIR/http-$name.log"
  # monitor mode puts the background job in its own process group (PGID == $!),
  # so the whole tree — Xvfb + Electron + renderers — dies with us instead of
  # holding the profile, the port and the display (pkill-by-name is not an
  # option: other QA sessions run concurrently on this host).
  set -m
  APPIMAGE="$img" LITE_USER_DATA="$RUNDIR/profile-$name" LITE_PORT=$((44590 + RANDOM % 80)) \
  LITE_UPDATE_CHANNEL="$chan" PLOTINA_QA_UPDATES="$qa" \
  PLOTINA_UPDATE_FEED_URL="$FEED_URL_BASE" LITE_DEV_FEED_URL="${FEED_URL_BASE}${devsub}" \
  LITE_NO_UPDATES=0 LITE_TRAY=0 \
  xvfb-run -a -s "-screen 0 1280x800x24" \
    "$UNPACKED/$runver/plotina-lite-desktop" --no-first-run >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 "$maxwait"); do
    grep -q "$marker" "$log" && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  sleep 1
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  sleep 1; kill -KILL -- "-$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  set +m
  stop_server
  RUN_IMG="$img"; RUN_LOG="$log"
}

echo "== A: stable channel installs the newer stable image"
write_yml latest-linux.yml 4.12.8-plotina.20 "$IMAGES/Plotina-Lite-Desktop-4.12.8-plotina.20-x86_64.AppImage"
run_case A 4.12.8-plotina.19 4.12.8-plotina.19 stable 1 "" '"state":"downloaded"' 40
grep -q '"channel":"stable"' "$RUN_LOG" || fail "A: status carries channel=stable"
grep -q '"state":"downloaded"' "$RUN_LOG" || fail "A: stable channel did not download"
grep -q 'latest-linux-dev.yml' "$LOGDIR/http-A.log" && fail "A: the stable channel read dev metadata"
grep -q 'GET /latest-linux.yml' "$LOGDIR/http-A.log" || fail "A: latest-linux.yml was not requested"
[ "$(sha512_b64 "$RUN_IMG")" = "$(sha512_b64 "$IMAGES/Plotina-Lite-Desktop-4.12.8-plotina.20-x86_64.AppImage")" ] \
  || fail "A: the running image was not swapped to the stable .20 bytes"
ls "$RUNDIR"/*.plotina-new >/dev/null 2>&1 && fail "A: staged file left behind"
echo "A OK (latest-linux.yml only, sha512 verified, atomic swap done)"

echo "== B: dev channel installs the dev image"
write_yml latest-linux-dev.yml 4.12.8-plotina.19-dev.1 "$IMAGES/Plotina-Lite-Desktop-4.12.8-plotina.19-dev.1-x86_64.AppImage"
run_case B 4.12.8-plotina.19 4.12.8-plotina.19 dev 1 "" '"state":"downloaded"' 40
grep -q '"channel":"dev"' "$RUN_LOG" || fail "B: status carries channel=dev"
grep -q 'GET /latest-linux-dev.yml' "$LOGDIR/http-B.log" || fail "B: dev metadata was not requested"
[ "$(sha512_b64 "$RUN_IMG")" = "$(sha512_b64 "$IMAGES/Plotina-Lite-Desktop-4.12.8-plotina.19-dev.1-x86_64.AppImage")" ] \
  || fail "B: the running image is not the dev build"
echo "B OK (dev channel picks latest-linux-dev.yml and installs 4.12.8-plotina.19-dev.1)"

echo "== C: dev channel via LITE_DEV_FEED_URL (production URL shape, no QA override)"
cp -f "$QA/feed/latest-linux-dev.yml" "$QA/feed/dev-latest/latest-linux-dev.yml"
cp -f "$IMAGES/Plotina-Lite-Desktop-4.12.8-plotina.19-dev.1-x86_64.AppImage" "$QA/feed/dev-latest/"
run_case C 4.12.8-plotina.19 4.12.8-plotina.19 dev 0 "dev-latest/" '"state":"downloaded"' 75
grep -q 'GET /dev-latest/latest-linux-dev.yml' "$LOGDIR/http-C.log" || fail "C: <base>/latest-linux-dev.yml was not fetched"
grep -q 'api.github.com' "$LOGDIR/http-C.log" && fail "C: the dev channel must not use the GitHub API"
[ "$(sha512_b64 "$RUN_IMG")" = "$(sha512_b64 "$IMAGES/Plotina-Lite-Desktop-4.12.8-plotina.19-dev.1-x86_64.AppImage")" ] \
  || fail "C: dev feed URL did not install the artifact"
echo "C OK (LITE_DEV_FEED_URL=<dir> -> <dir>/latest-linux-dev.yml -> verified install)"

echo "== D: a dev install on the stable channel is never auto-downgraded"
write_yml latest-linux.yml 4.12.8-plotina.19 "$IMAGES/Plotina-Lite-Desktop-4.12.8-plotina.20-x86_64.AppImage"
run_case D 4.12.8-plotina.19-dev.1 4.12.8-plotina.19-dev.1 stable 1 "" 'not applied' 40
grep -q '"state":"downloaded"' "$RUN_LOG" && fail "D: a version reduction was applied automatically"
grep -q 'Plotina-Lite-Desktop-4.12.8-plotina.20-x86_64.AppImage' "$LOGDIR/http-D.log" \
  && fail "D: the offered artifact was downloaded anyway"
[ "$(sha512_b64 "$RUN_IMG")" = "$(sha512_b64 "$IMAGES/Plotina-Lite-Desktop-4.12.8-plotina.19-dev.1-x86_64.AppImage")" ] \
  || fail "D: the dev image was modified"
echo "D OK (reduction refused; only 'Вернуться на стабильный' may install it)"

echo; echo "ALL CHANNEL PROOFS PASSED — logs in $LOGDIR, images untouched in $IMAGES"
[ "${KEEP:-0}" = 1 ] && echo "run dir kept: $RUNDIR" || true
