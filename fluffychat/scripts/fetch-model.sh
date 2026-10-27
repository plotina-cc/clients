#!/usr/bin/env bash
# Fetches the DeepFilterNet3 ONNX model that libDF loads at runtime.
#
# Byte-identical to what the web clients ship (see noise.lock.json in this
# repository): same upstream file, same SHA-256. Kept out of git because it is
# 7.6 MiB of binary that never changes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
url="https://raw.githubusercontent.com/Rikorose/DeepFilterNet/v0.5.6/models/DeepFilterNet3_onnx.tar.gz"
sha="c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616"
out="$here/plotina_dfn/assets/DeepFilterNet3_onnx.tar.gz"

if [ -f "$out" ] && echo "$sha  $out" | sha256sum --check --status; then
  echo "model already present: $out"
  exit 0
fi

mkdir -p "$(dirname "$out")"
tmp="$(mktemp "$out.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

echo "fetching $url"
curl -fsSL --retry 3 -o "$tmp" "$url"
echo "$sha  $tmp" | sha256sum --check --status || {
  echo "SHA-256 mismatch for $url" >&2
  exit 1
}
mv "$tmp" "$out"
echo "model ready: $out ($(stat -c%s "$out") bytes)"
