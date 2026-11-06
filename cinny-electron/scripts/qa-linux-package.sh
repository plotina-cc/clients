#!/usr/bin/env bash
# Linux smoke test for the PACKAGED Plotina Lite Desktop (Electron).
#
#   bash scripts/qa-linux-package.sh appimage   # uses dist/*.AppImage
#   bash scripts/qa-linux-package.sh deb        # unpacks dist/*.deb into a temp PREFIX
#
# Asserts (window identity — the icon/WM_CLASS contract from the migration
# plan §6.3/§6.4):
#   * WM_CLASS contains plotina-lite-desktop  (StartupWMClass must match)
#   * _NET_WM_ICON is non-empty and reports a 128 x 128 icon
#   * window title is exactly 'Plotina Lite Desktop'
#   * main log shows the updater accepting the packaged app-update.yml feed
#     (owner plotina-cc / repo clients) with the right install kind
# then runs the full qa.mjs harness against the packaged binary (WebRTC,
# SSO opener, deep link, messaging) and prints the PASS summary.
# SKIP_QA_HARNESS=1 stops after the identity asserts (CI has no session token).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${QA_OUT:-$HOME/.hermes/cache/scratch/lite-electron-qa}"
mkdir -p "$OUT"
KIND="${1:-appimage}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Own display: re-exec the WHOLE script under one Xvfb (via xvfb-run -a,
# which picks a free display itself and tolerates the stale locks other QA
# sessions leave on this shared host) so the app AND the xprop/xdotool
# assertions share DISPLAY. Done FIRST so nothing runs twice.
if [ -z "${DISPLAY:-}" ]; then
  echo "re-exec under xvfb-run"
  exec xvfb-run -a -s "-screen 0 1440x900x24" bash "$0" "$@"
fi

BIN=""
APPIMAGE=""
if [ "$KIND" = "appimage" ]; then
  ai="$(ls "$HERE"/dist/*.AppImage | head -1)"
  echo "extracting $ai"
  ( cd "$WORK" && "$ai" --appimage-extract >/dev/null )
  # Run the extracted AppRun; we export APPIMAGE ourselves so the in-app
  # install-kind detection sees the appimage path (the runtime would set it
  # when mounting via FUSE).
  BIN="$WORK/squashfs-root/AppRun"
  APPIMAGE="$ai"
else
  deb="$(ls "$HERE"/dist/*.deb | head -1)"
  echo "unpacking $deb"
  ( cd "$WORK" && ar x "$deb" && mkdir data && tar -xf "$(echo data.tar.*)" -C data )
  BIN="$(find "$WORK/data/opt" -maxdepth 3 -type f -name plotina-lite-desktop | head -1)"
  chmod +x "$BIN"
fi
[ -x "$BIN" ] || { echo "no binary for $KIND" >&2; exit 1; }

PROFILE="$WORK/profile"
LOG="$WORK/main.log"
export APPIMAGE LITE_USER_DATA="$PROFILE" LITE_TRAY=0 LITE_ECHO_CONSOLE=0
echo "launching $BIN"
"$BIN" --no-first-run >"$LOG" 2>&1 &
PID=$!

TITLE_OK=0; WM_OK=0; ICON_OK=0; UPD_OK=0
WID=""
for i in $(seq 1 120); do
  kill -0 $PID 2>/dev/null || break
  WID=$( (xdotool search --onlyvisible --name "Plotina Lite Desktop" 2>/dev/null || true) | head -1 )
  [ -n "$WID" ] && break
  sleep 0.5
done
if [ -n "${WID:-}" ]; then
  XP=$(xprop -id "$WID" WM_CLASS WM_NAME _NET_WM_ICON 2>/dev/null || true)
  echo "--- xprop ---"
  echo "$XP" | sed 's/\(_NET_WM_ICON(CARDINAL) = \).*/\1<icon data>/'
  grep -q 'plotina-lite-desktop' <<<"$XP" && WM_OK=1
  grep -qE 'WM_NAME\(.*\) = "Plotina Lite Desktop"' <<<"$XP" && TITLE_OK=1
  # _NET_WM_ICON: this xprop renders "Icon (128 x 128):" (tab-prefixed, array
  # elided); other builds dump raw CARDINALs (first two are width,height).
  # Either shape must report a 128x128 icon — the BrowserWindow cap that keeps
  # the property under the X protocol request limit.
  iconvals=$( (xprop -notr -id "$WID" _NET_WM_ICON 2>/dev/null || true) | tr '\n' ' ' | sed 's/.*= //')
  iw=$(echo "$iconvals" | awk '{print $1}')
  ih=$(echo "$iconvals" | awk '{print $2}')
  nvals=$(echo "$iconvals" | wc -w)
  echo "_NET_WM_ICON: raw first cardinals: ${iw:-?} ${ih:-?} (${nvals} values)"
  if grep -q 'Icon (128 x 128)' <<<"$XP"; then ICON_OK=1; fi
  if [ "${iw:-0}" = 128 ] && [ "${ih:-0}" = 128 ]; then ICON_OK=1; fi
fi
sleep 2
# appimage/nsis kinds log "feed <owner>/<repo> kind=..."; package/unknown/msi
# log "install kind '<kind>': no self-update polling". Either proves the
# packaged updater booted and classified the install.
grep -qE '\[updater\] (feed .*kind=|install kind .[a-z]+.)' "$LOG" && UPD_OK=1
kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true

echo "WM_CLASS=$WM_OK title=$TITLE_OK _NET_WM_ICON(128)=$ICON_OK updater=$UPD_OK"
[ "$TITLE_OK" = 1 ] || { echo "FAIL: window title"; tail -40 "$LOG"; exit 1; }
[ "$WM_OK" = 1 ]    || { echo "FAIL: WM_CLASS not plotina-lite-desktop"; exit 1; }
[ "$ICON_OK" = 1 ]  || { echo "FAIL: _NET_WM_ICON missing or not 128x128"; exit 1; }
[ "$UPD_OK" = 1 ]   || { echo "FAIL: updater did not parse app-update.yml"; tail -40 "$LOG"; exit 1; }

# Full behavioural harness against the packaged binary (DISPLAY already set).
if [ "${SKIP_QA_HARNESS:-0}" = "1" ]; then
  echo "SMOKE($KIND) identity asserts OK (behavioural harness skipped)"
  exit 0
fi
cd "$HERE"
LITE_NO_UPDATES=1 QA_BIN="$BIN" node scripts/qa.mjs
echo "SMOKE($KIND) OK"
