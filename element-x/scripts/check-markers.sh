#!/usr/bin/env bash
# Checks that every applied patch is actually inside the built APK.
#
# The point: a green build used to mean "the workflow's patch list ran", not "the artifact has the
# change". Patch 0016 was in patches/, was reviewed, and was absent from the .32-dev.4 APK because
# the build listed its siblings by hand — the APK was green and wrong. apply-patches.sh now removes
# the list, and this script removes the trust: it takes the markers of the patches that were really
# applied and looks for each one in the APK itself.
#
# How a marker is found: the APK is decompressed into one byte stream (`unzip -p`, all entries) and
# that stream is run through `strings` twice — UTF-8 and UTF-16LE — because a marker can live in the
# dex string pool, in resources.arsc, in the compiled AndroidManifest.xml or in an asset. Kotlin and
# Java string literals are only reliable after R8: it deletes the literals of code it removes, which
# is why the markers are checked here and not on the source tree.
#
# Usage: check-markers.sh <apk> <markers-file>
#   <apk>            the artifact to check (Plotina-X.apk)
#   <markers-file>   `<patch-name><TAB><token>` lines from apply-patches.sh

set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <apk> <markers-file>" >&2
    exit 2
}

[ "$#" -ge 2 ] || usage
apk="$1"
markers="$2"
[ -f "$apk" ] || { echo "::error::no APK at $apk" >&2; exit 2; }
[ -f "$markers" ] || { echo "::error::no marker list at $markers" >&2; exit 2; }

# A marker list with no entries would make every run green: that is the failure this gate exists to
# prevent, so it is an error rather than a pass.
if ! grep -qvE '^[[:space:]]*(#|$)' "$markers"; then
    echo "::error::$markers holds no markers: the gate would check nothing" >&2
    exit 1
fi

bytes="$(mktemp "${TMPDIR:-/tmp}/plotina-apk.XXXXXX")"
text="$(mktemp "${TMPDIR:-/tmp}/plotina-apk-strings.XXXXXX")"

# One pass over the archive; unzip prints each entry to stdout and, for a non-zip file, prints
# nothing, which is caught below instead of silently passing every marker.
unzip -p "$apk" > "$bytes" 2>/dev/null || true
if [ ! -s "$bytes" ]; then
    echo "::error::$apk could not be read as a zip archive — the artifact is broken" >&2
    exit 1
fi
{
    strings -a -n 4 "$bytes"
    strings -a -n 4 -e l "$bytes"
} > "$text"

total=0
missing=0
missing_report=""
while IFS=$'\t' read -r patch token; do
    case "$patch" in
        ''|'#'*) continue ;;
    esac
    if [ -z "${token:-}" ]; then
        echo "::error::marker list line for '$patch' has no token" >&2
        exit 1
    fi
    total=$((total + 1))
    if grep -qF -- "$token" "$text"; then
        printf 'ok: %s (%s)\n' "$patch" "$token"
    else
        printf '::error::marker missing: %s — "%s" is not in %s\n' \
            "$patch" "$token" "$(basename "$apk")"
        missing=$((missing + 1))
        missing_report="${missing_report}    ${patch}  (\"${token}\")
"
    fi
done < "$markers"

if [ "$missing" -ne 0 ]; then
    echo "::error::$missing of $total applied patches are not in $(basename "$apk"):" >&2
    printf '%s' "$missing_report" >&2
    echo "  The build compiled a tree without them. Check that every patches/*.patch applied and" >&2
    echo "  that R8 did not strip the code that carries the marker." >&2
    exit 1
fi

printf 'markers: %d/%d present in %s\n' "$total" "$total" "$(basename "$apk")"
