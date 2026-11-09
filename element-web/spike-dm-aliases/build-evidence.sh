#!/usr/bin/env bash
# Record the build-side evidence for SPIKE-dm-aliases.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EV="$ROOT/element-web/spike-dm-aliases"
B="$ROOT/element-desktop/.build/webapp"
LOG="${1:-/tmp/prepare-webapp2.log}"

{
  echo "== prepare-webapp.sh (element-desktop/scripts/prepare-webapp.sh, SENTRY_DSN = local test key)"
  grep -E '^(==>|webapp ready|branding: index.html: plotina)' "$LOG"
  echo
  echo "== built index.html: alias tag"
  grep -o 'plotina-dm-aliases.js" defer>' "$B/index.html"
  printf 'count: %s\n' "$(grep -oF 'src="plotina-dm-aliases.js"' "$B/index.html" | wc -l)"
  echo
  echo "== payload byte-identical to element-web/plotina-dm-aliases.js"
  cmp "$B/plotina-dm-aliases.js" "$ROOT/element-web/plotina-dm-aliases.js"
  printf 'cmp: identical (%s bytes)\n' "$(wc -c < "$ROOT/element-web/plotina-dm-aliases.js")"
} > "$EV/build.txt"

cat "$EV/build.txt"