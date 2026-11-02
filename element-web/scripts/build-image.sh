#!/usr/bin/env bash
# Build the Plotina Element Web image from this directory.
#
# The Dockerfile expects the shared ../noise overlay in its build context, while
# the source tree keeps that overlay one level up. Assemble a throwaway context
# instead of duplicating the files or relying on a manually created symlink.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
TAG="${1:-plotina/element-web:1.12.32-noise12}"
CTX="$(mktemp -d)"
trap 'rm -rf "$CTX"' EXIT

cp -a "$ROOT"/. "$CTX"/
cp -a "$ROOT/../noise" "$CTX/noise"
docker build -t "$TAG" "$CTX"
