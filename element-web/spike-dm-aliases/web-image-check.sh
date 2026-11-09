#!/usr/bin/env bash
# Read the alias overlay back out of the built Element Web image.
set -euo pipefail
IMG=plotina/element-web:spike-dm-aliases
NAME=webev-check
sudo -n docker rm -f "$NAME" >/dev/null 2>&1 || true
sudo -n docker create --name "$NAME" "$IMG" >/dev/null
sudo -n docker cp "$NAME:/app/index.html" /tmp/app-index.html
sudo -n docker cp "$NAME:/app/plotina-dm-aliases.js" /tmp/app-dm-aliases.js
printf 'alias tag occurrences in /app/index.html: '
grep -oF 'src="/plotina-dm-aliases.js"' /tmp/app-index.html | wc -l
printf 'relative tag occurrences (must be 0): '
{ grep -oF 'src="plotina-dm-aliases.js"' /tmp/app-index.html || true; } | wc -l
printf 'payload bytes in /app: '
wc -c < /tmp/app-dm-aliases.js
printf 'payload identical to element-web/plotina-dm-aliases.js: '
cmp -s /tmp/app-dm-aliases.js \
  /home/hermes/clients/.worktrees/t_b6d8c35f/element-web/plotina-dm-aliases.js \
  && echo yes || echo no
printf 'tag line: '
grep -o '<script src="/plotina-dm-aliases.js" defer></script>' /tmp/app-index.html
sudo -n docker rm -f "$NAME" >/dev/null