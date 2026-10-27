#!/usr/bin/env bash
# Move the Element Web overlay to a new upstream release.
#
#   scripts/bump-element.sh 1.13.0
#
# Resolves the digest, rewrites the FROM line, rebuilds the image and runs both
# test suites. Refuses to leave a half-bumped Dockerfile behind if tests fail:
# the original file is restored.
set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 <element-web tag, e.g. 1.13.0>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
DOCKERFILE="$ROOT/element-web/Dockerfile"
IMAGE_REPO="vectorim/element-web"
NEW_IMAGE="${IMAGE_REPO}:v${TAG}"

echo "==> resolving ${NEW_IMAGE}"
docker pull "${NEW_IMAGE}" >/dev/null
DIGEST="$(docker image inspect "${NEW_IMAGE}" --format '{{index .RepoDigests 0}}' | sed 's/.*@//')"
if [[ -z "$DIGEST" ]]; then
  echo "could not resolve a digest for ${NEW_IMAGE}" >&2
  exit 1
fi
echo "    ${DIGEST}"

BACKUP="$(mktemp)"
cp "$DOCKERFILE" "$BACKUP"

restore() {
  cp "$BACKUP" "$DOCKERFILE"
  rm -f "$BACKUP"
  echo "!! Dockerfile restored, nothing deployed"
}

sed -i -E "s#^FROM .*#FROM ${NEW_IMAGE}@${DIGEST}#" "$DOCKERFILE"
grep -q "^FROM ${NEW_IMAGE}@${DIGEST}\$" "$DOCKERFILE" || { restore; exit 1; }

echo "==> building plotina/element-web:${TAG}-noise1"
if ! docker build -q -f "$DOCKERFILE" -t "plotina/element-web:${TAG}-noise1" "$ROOT"; then
  restore
  exit 1
fi

echo "==> unit tests"
if ! IMAGE="plotina/element-web:${TAG}-noise1" "$ROOT/element-web/tests/run.sh"; then
  restore
  exit 1
fi

echo "==> integration tests"
if ! IMAGE="plotina/element-web:${TAG}-noise1" "$ROOT/element-web/tests/integration.sh"; then
  restore
  exit 1
fi

rm -f "$BACKUP"
echo
echo "OK: plotina/element-web:${TAG}-noise1 is ready."
echo "Next: set that tag in stack/docker-compose.yml, docker compose up -d element,"
echo "then open Settings -> Voice & Video and confirm the slider is present."
