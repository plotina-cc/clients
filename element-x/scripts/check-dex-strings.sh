#!/usr/bin/env bash
# Checks two strings against the string pool of a built APK's dex files: one that must be there
# and one that must not.
#
# Why this exists separately from check-markers.sh: a marker gate can only prove that something
# arrived. The shape that bit us is a *default* that survives — Plotina X sent MAS
# `logo_uri = https://element.io/mobile-icon.png` because `URL_LOGO` was null and the Gradle
# fallback was Element's, and every gate we had was green about it (the artifact was correct for
# everything the patches did, and wrong about the one value none of them set). Absence needs its
# own check, checked in the same place: classes*.dex.
#
# Only classes*.dex is scanned — deliberately. A literal that lives in resources or an asset does
# not decide a Kotlin constant, and grepping the whole archive would find the string in places that
# do not affect the build config.
#
# Usage: check-dex-strings.sh <apk> <must-be-present> <must-be-absent>
#   <apk>               the artifact to check (Plotina-X.apk)
#   <must-be-present>   string literal that the build must contain in a classes*.dex
#   <must-be-absent>    string literal that must not appear in any classes*.dex

set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <apk> <must-be-present> <must-be-absent>" >&2
    exit 2
}

[ "$#" -eq 3 ] || usage
apk="$1"
present="$2"
absent="$3"
[ -f "$apk" ] || { echo "::error::no APK at $apk" >&2; exit 2; }

# One read of the dex entries into a temp file: the archive is decompressed once and both searches
# run against the same bytes, which is also what makes the negative case trustworthy (a broken read
# cannot look like an absence).
bytes="$(mktemp "${TMPDIR:-/tmp}/plotina-dex.XXXXXX")"
trap 'rm -f "$bytes"' EXIT

if ! unzip -p "$apk" 'classes*.dex' > "$bytes" 2>/dev/null || [ ! -s "$bytes" ]; then
    echo "::error::$apk has no readable classes*.dex: the artifact is broken, not checked" >&2
    exit 1
fi

dex_entries="$(unzip -Z1 "$apk" 'classes*.dex' 2>/dev/null | wc -l | tr -d ' ')"
failed=0

# Both directions are reported, not just the first: a build that lost our literal *and* kept
# Element's is one broken contract, and a report that names only half of it reads like a typo.
if grep -a -F -q -- "$present" "$bytes"; then
    echo "ok: $present is in classes*.dex"
else
    echo "::error::$present is not in any classes*.dex of $apk ($dex_entries dex entries scanned)" >&2
    failed=1
fi

if grep -a -F -q -- "$absent" "$bytes"; then
    echo "::error::$absent is still in a classes*.dex of $apk: the default survived the patch" >&2
    failed=1
else
    echo "ok: $absent is absent from classes*.dex"
fi

echo "checked: $(basename "$apk") ($dex_entries dex entries)"
exit "$failed"
