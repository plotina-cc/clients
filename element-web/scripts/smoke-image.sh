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
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "$PAGE"
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

# Licence and notice have to travel with the served app.
curl -fsS "http://127.0.0.1:${PORT}/LICENSE-AGPL-3.0" | head -1 | grep -q 'GNU AFFERO GENERAL PUBLIC LICENSE'
curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/NOTICE"

echo "smoke ok: $IMAGE"
