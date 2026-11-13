#!/usr/bin/env bash
# Early gate for Plotina Desktop tag builds: a dev tag (`-dev.M`) may only be
# cut on a base whose stable release is already PUBLISHED.
#
#   guard-dev-base.sh <tag>            # or from $GITHUB_REF_NAME
#
# Why the releases API and not `git ls-remote --tags`: on
# `v1.12.32-plotina-desktop.49` the tag existed for hours before any release
# did. "The tag exists" would have passed exactly the case this gate is meant to
# stop — a dev build on a base nobody can download or update from. So the gate
# asks for the release by tag (`gh api .../releases/tags/<tag>`) and then for the
# updater metadata inside it: `latest-linux.yml` (AppImage/deb) and `latest.yml`
# (Windows). A release without those cannot update anyone, so it does not count
# as published.
#
# Stable tags are deliberately out of scope: the first release of a new base has
# no published base to point at, and gating it would block every base bump.
#
# Exit codes: 0 = allowed (or not applicable), 1 = the base is not published,
# 2 = fail closed (unparseable dev tag / no `gh`).
set -euo pipefail

TAG="${1:-${GITHUB_REF_NAME:-}}"
REPO="${PLOTINA_RELEASE_REPO:-${GITHUB_REPOSITORY:-plotina-cc/clients}}"

note() { printf '%s\n' "$*"; }
deny() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
fail_closed() { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

case "$TAG" in
  *-dev.*) ;;
  *)
    note "tag '$TAG' не dev-тег: проверка опубликованной базы не применяется"
    exit 0
    ;;
esac

# v<upstream>-plotina-desktop.<N>-dev.<M>  ->  base v<upstream>-plotina-desktop.<N>
if [[ "$TAG" =~ ^(.+)-plotina-desktop\.([0-9]+)-dev\.[0-9]+$ ]]; then
  base="${BASH_REMATCH[1]}-plotina-desktop.${BASH_REMATCH[2]}"
else
  fail_closed "не удалось разобрать dev-тег '$TAG': ожидается v<версия>-plotina-desktop.<N>-dev.<M>; проверить базу невозможно, поэтому тег отклонён"
fi

if ! command -v gh >/dev/null 2>&1; then
  fail_closed "gh не найден: без него нельзя проверить, опубликована ли база '$base'"
fi

# `--jq` keeps the parsing in gh itself (it bundles jq): no jq/python on the
# runner, and asset names come out one per line. A missing release makes gh exit
# non-zero with "Not Found (HTTP 404)".
if ! assets="$(gh api "repos/${REPO}/releases/tags/${base}" --jq '.assets[].name' 2>&1)"; then
  deny "база \`${base}\` не опубликована, dev-теги на ней запрещены — релиз ${REPO}@${base} не найден (тег без релиза не считается публикацией). Сначала выпустите стабильный релиз этой базы, затем перережьте dev-тег.
  gh: ${assets}"
fi

if [ -z "${assets//[[:space:]]/}" ]; then
  deny "база \`${base}\` не опубликована, dev-теги на ней запрещены — в релизе ${REPO}@${base} нет ни одного ассета"
fi

missing=()
for want in latest-linux.yml latest.yml; do
  if ! printf '%s\n' "$assets" | grep -qx "$want"; then
    missing+=("$want")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  deny "база \`${base}\` не опубликована, dev-теги на ней запрещены — в релизе ${REPO}@${base} нет $(printf '%s, ' "${missing[@]}" | sed 's/, $//'); релиз без метаданных обновлений не считается публикацией
  ассеты релиза: $(printf '%s' "$assets" | tr '\n' ' ')"
fi

note "база \`${base}\` опубликована (ассеты: $(printf '%s, ' latest-linux.yml latest.yml | sed 's/, $//')) — dev-тег '${TAG}' разрешён"
