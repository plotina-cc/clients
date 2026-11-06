#!/usr/bin/env bash
# Plotina Lite Desktop — Electron regression entrypoint.
#
#   ./run-regression.sh [options] <target>
#
#   <target>   AppImage | .deb | unpacked dir | AppImage-extracted dir |
#              Electron prototype repo dir (cinny-electron with node_modules)
#   --out DIR  evidence dir (default /home/hermes/.hermes/cache/scratch/lite-qa-runs/<stamp>)
#   --dist DIR Cinny web dist for prototype targets (packaged builds ignore it)
#   --timeout SECONDS  overall watchdog (default 2400)
#   --keep     leave Xvfb/openbox/feed running (debugging; prints PIDs)
#   --token-file PATH  QA Matrix access token (default qa-matrix-token in cache)
#
# Provisions per-run isolation: unique X display, unique CDP port, unique local
# updater-feed port, fresh HOME/XDG dirs, private dbus session, fake xdg-open
# on PATH. A trap kills everything referencing this run dir; exits 1 if any
# scenario FAILs (SKIP does not fail the run; the report lists reasons).
#
# NEVER prints the token. Results: OUT/results.json + OUT/REPORT.md + shots/.
set -u -o pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
HERE="$PWD"
QA_REPO="$(cd ../.. && pwd)"

TARGET="" OUT="" DIST="" TIMEOUT=2400 KEEP=0 TOKEN_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --dist) DIST="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --token-file) TOKEN_FILE="$2"; shift 2;;
    --keep) KEEP=1; shift;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    -*) echo "unknown option $1" >&2; exit 64;;
    *) TARGET="$1"; shift;;
  esac
done
[[ -n "$TARGET" ]] || { echo "usage: run-regression.sh [options] <AppImage|deb|unpacked-dir>" >&2; exit 64; }
[[ -e "$TARGET" ]] || { echo "target not found: $TARGET" >&2; exit 64; }

# ------------------------------------------------------------ prerequisites
need() { command -v "$1" >/dev/null 2>&1 || { echo "MISSING REQUIRED TOOL: $1" >&2; exit 65; }; }
for t in node Xvfb xprop; do need "$t"; done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" -ge 22 ]] || { echo "node >= 22 required (global WebSocket/fetch); found $(node --version)" >&2; exit 65; }
command -v openbox >/dev/null 2>&1 || echo "note: openbox not installed; windows will be unmanaged (bounds/window-state checks may skip)" >&2
if [[ "$TARGET" == *.deb ]]; then need dpkg-deb; fi

# ------------------------------------------------------------ unique ids
STAMP="$(date -u +%Y%m%d-%H%M%S)-$$"
RUN_ID="lite-qa-$STAMP"
OUT="${OUT:-/home/hermes/.hermes/cache/scratch/lite-qa-runs/$STAMP}"
mkdir -p "$OUT"
: > "$OUT/pids"

free_display() {  # prefer the matrix's E1 range, then anything free
  for d in 130 132 133 134 140 141 142 143 150 151 152; do
    [[ -e "/tmp/.X11-unix/X$d" ]] || { echo "$d"; return; }
  done
  echo "no free display in :130-:152" >&2; exit 65
}
port_free() { (echo >/dev/tcp/127.0.0.1/"$1") 2>/dev/null && return 1 || return 0; }
free_port() {
  local p="$1"
  while ! port_free "$p"; do p=$((p+1)); done
  echo "$p"
}
DISPLAY_NUM="$(free_display)"
CDP_PORT="$(free_port 9401)"
FEED_PORT="$(free_port 9440)"

# ----------------------------------------------------------- isolated HOME
export HOME="$OUT/home"
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache" XDG_DATA_HOME="$HOME/.local/share"
export XDG_STATE_HOME="$HOME/.local/state"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
export XDG_RUNTIME_DIR="$OUT/runtime"; chmod 700 "$XDG_RUNTIME_DIR"
export DISPLAY=":$DISPLAY_NUM"
export QA_RUN_ID="$RUN_ID"
export QA_CDP_PORT="$CDP_PORT" QA_FEED_PORT="$FEED_PORT"
export QA_XDG_LOG="$OUT/xdg-open.log"; : > "$QA_XDG_LOG"
[[ -n "$DIST" ]] && export QA_DIST="$DIST"
[[ -n "$TOKEN_FILE" ]] && export QA_TOKEN_FILE="$TOKEN_FILE"

# fake xdg-open first on PATH: records external-URL routing instead of opening
# a real browser/mail client.
export PATH="$HERE/bin:$PATH"

# --------------------------------------------------------------- cleanup
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  # kill any *other* process whose cmdline references this run dir (app
  # instances, feed server leftovers, WMs) — never ourselves / our parent.
  local pid
  for pid in $(pgrep -f -- "$OUT" 2>/dev/null); do
    [[ "$pid" == "$$" || "$pid" == "$PPID" ]] && continue
    kill -9 "$pid" 2>/dev/null
  done
  for pid in $(pgrep -f -- "remote-debugging-port=$CDP_PORT" 2>/dev/null); do
    [[ "$pid" == "$$" ]] && continue
    kill -9 "$pid" 2>/dev/null
  done
  if [[ -f "$OUT/pids" ]]; then
    while read -r pid _; do [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null; done < "$OUT/pids"
    sleep 1
    while read -r pid _; do [[ -n "$pid" ]] && kill -9 "$pid" 2>/dev/null; done < "$OUT/pids"
  fi
  if [[ "$KEEP" == 1 ]]; then
    echo "note: --keep given but processes were still reaped; display was :$DISPLAY_NUM"
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

start() { # start <desc> <cmd...> ; records pid
  local desc="$1"; shift
  "$@" &
  local pid=$!
  echo "$pid $desc" >> "$OUT/pids"
  echo "$desc pid=$pid" >> "$OUT/daemons.log"
}

# ---------------------------------------------------------------- daemons
start "Xvfb:$DISPLAY_NUM" Xvfb ":$DISPLAY_NUM" -screen 0 1400x900x24 -nolisten tcp > "$OUT/xvfb.log" 2>&1
for _ in $(seq 1 50); do [[ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]] && break; sleep 0.2; done
[[ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]] || { echo "Xvfb :$DISPLAY_NUM failed to start; see $OUT/xvfb.log" >&2; exit 65; }

if command -v openbox >/dev/null 2>&1; then
  start "openbox" openbox > "$OUT/openbox.log" 2>&1
  sleep 1
fi

echo "== Plotina Lite regression =="
echo "target=$TARGET"
echo "display=:$DISPLAY_NUM cdp=$CDP_PORT feed=$FEED_PORT"
echo "home=$HOME out=$OUT"

# dbus-run-session gives Electron a session bus (notifications/tray/portal-adjacent checks)
if command -v dbus-run-session >/dev/null 2>&1; then
  DBUS_WRAP=(dbus-run-session --)
else
  DBUS_WRAP=()
  echo "note: dbus-run-session missing; running without a session bus" >&2
fi

"${DBUS_WRAP[@]}" timeout --kill-after=30 "$TIMEOUT" \
  node "$HERE/regression.mjs" --target "$TARGET" --out "$OUT" \
  2>&1 | tee "$OUT/console.log"

rc="${PIPESTATUS[0]}"
echo
echo "== run finished rc=$rc =="
echo "evidence: $OUT"
[[ -f "$OUT/REPORT.md" ]] && sed -n '1,8p' "$OUT/REPORT.md"
exit "$rc"
