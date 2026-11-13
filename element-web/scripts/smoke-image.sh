#!/usr/bin/env bash
# Serve a built Plotina Web image and check the two things a publish must not
# lose: the brand pass (title, icon) and the noise overlay (script tags and the
# model assets behind them). The image itself is never modified.
#
#   element-web/scripts/smoke-image.sh ghcr.io/plotina-cc/element-web:sha-<sha>
#
# Runs on a GitHub runner in build-element-web.yml before anything is pushed and
# again on the digest that came back from the registry.
set -euo pipefail

IMAGE="${1:?usage: smoke-image.sh IMAGE:REF}"
PORT="${PORT:-18096}"
NAME="plotina-web-smoke-$$"
PAGE="$(mktemp)"
BUNDLE="$(mktemp)"
LICENCE="$(mktemp)"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "$PAGE" "$BUNDLE" "${LICENCE:-}"
}
trap cleanup EXIT

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:80" "$IMAGE" >/dev/null

# nginx with envsubst starts in well under a second, but the first request after
# a fresh image can race it; retry instead of sleeping a fixed time.
ok=""
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/" -o "$PAGE" 2>/dev/null; then
    ok=1
    break
  fi
  sleep 1
done
if [ -z "$ok" ]; then
  docker logs "$NAME" >&2 || true
  echo "the image never served / on port ${PORT}" >&2
  exit 1
fi

# Brand pass: the title is rewritten by branding.py and the icon replaces the
# Element mark. Both are pinned by element-web/tests/branding_test.py too; here
# they prove the built image, not the sources.
grep -q '<title>Plotina Web</title>' "$PAGE"
grep -q 'href="/plotina-icon.svg"' "$PAGE"
grep -q 'noise/logic.js' "$PAGE"
grep -q 'noise/boot.js' "$PAGE"

# Noise assets: the wasm and the config the overlay boots from must be served by
# the image, not fetched by the browser from a CDN.
for path in \
  /noise/dfn/v3/pkg/df_bg.wasm \
  /noise/vendor/dpdfnet.esm.js \
  /noise/vendor/dpdfnet/dpdfnet2_48khz_hr/config.ini \
  /plotina-icon.svg \
  /plotina-icon-192.png \
  /manifest.json; do
  curl -fsS -o /dev/null "http://127.0.0.1:${PORT}${path}"
done

# Our Element Call. Element Web opens the call widget at ./widgets/element-call/
# from the site root, and the served bundle has to be ours: the stock upstream
# widget has neither the per-person volume store nor the hide-stream control.
# The Dockerfile gates the build with the same checker; this proves the running
# container, which is what a publish and a QA pull see.
WIDGET="http://127.0.0.1:${PORT}/widgets/element-call"
curl -fsS -o "$PAGE" "$WIDGET/index.html"
grep -q 'window.__plotinaEc=true' "$PAGE"
grep -q 'src="/widgets/element-call/assets/' "$PAGE"
grep -q 'src="../../noise/plotina-dfn.js"' "$PAGE"
# The noise level lives in Element Call's Settings -> Audio since .17; the
# floating capsule of .16 and earlier is gone, so the widget must not ask for its
# script and the root noise layer must not serve it. Both are inverted here: a
# widget that still loads the panel is the previous archive, not the one the lock
# pins.
if grep -q 'plotina-panel' "$PAGE"; then
  echo "the widget index still loads the removed noise capsule panel" >&2
  exit 1
fi
curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/noise/plotina-dfn.js"
if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/noise/plotina-panel.js" 2>/dev/null; then
  echo "the image still serves /noise/plotina-panel.js (removed with the capsule)" >&2
  exit 1
fi
# The archive's own noise tree must not have come along (it would be 24 MB and a
# second denoiser init): the prefix returns 404 for the widget-local copy.
if curl -fsS -o /dev/null "$WIDGET/noise/boot.js" 2>/dev/null; then
  echo "the widget ships its own noise/ tree" >&2
  exit 1
fi

BUNDLE_PATH="$(grep -o 'src="[^"]*assets/index-[^"]*\.js"' "$PAGE" | head -1 | sed 's/^src="//; s/"$//')"
test -n "$BUNDLE_PATH"
curl -fsS -o "$BUNDLE" "http://127.0.0.1:${PORT}${BUNDLE_PATH}"
voice_volumes="$(grep -o 'cc.plotina.voice_volumes' "$BUNDLE" | wc -l)"
set_subscribed="$(grep -o 'setSubscribed' "$BUNDLE" | wc -l)"
stream_paused="$(grep -o 'video_tile.stream_paused' "$BUNDLE" | wc -l)"
# `|| true` is load-bearing: the key must be absent, and a bare grep would exit 1
# here, which `set -e` + `pipefail` turn into a silent abort before any check
# runs (that is how the .16 smoke test died in 1.4 s the first time).
old_menu="$(grep -o 'video_tile.hide_stream' "$BUNDLE" | wc -l || true)"
echo "widget bundle: voice_volumes=$voice_volumes setSubscribed=$set_subscribed stream_paused=$stream_paused hide_stream=$old_menu"
test "$voice_volumes" -gt 0
test "$set_subscribed" -gt 0
test "$stream_paused" -gt 0
# .16 replaced the hide_stream submenu: a bundle that still ships it is the
# previous archive, and publishing it would undo the change this image carries.
test "$old_menu" -eq 0

# Licence and notice have to travel with the served app. The licence is read
# through a file, not a pipe: `curl | head -1` makes curl die with 23 (SIGPIPE)
# the moment head closes the pipe, and `set -o pipefail` turns that into a
# failure of a check that actually passed.
LICENCE="$(mktemp)"
curl -fsS "http://127.0.0.1:${PORT}/LICENSE-AGPL-3.0" -o "$LICENCE"
head -1 "$LICENCE" | grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE'
curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/NOTICE"

echo "smoke ok: $IMAGE"
