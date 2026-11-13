#!/usr/bin/env bash
# Checks that every applied patch is actually inside the built artifact.
#
# The point: a green build used to mean "the workflow's patch loop ran", not "the artifact has the
# change". Element X shipped .32-dev.4 without patch 0016 — the APK was green and wrong — and the
# owner found it on his phone. apply-patches.sh removes the hand-written list; this script removes
# the trust: it takes the markers of the patches that were really applied and looks for each one in
# the artifact itself.
#
# The artifact is whatever the client ships, so four shapes are understood:
#   * a directory        — cinny's built web dist, element-call's unpacked bundle
#   * a zip              — an Android APK (Flutter or otherwise)
#   * a gzip'd tar       — a packaged dist
#   * any other file     — an app.asar or an AppImage
# In every case the bytes are streamed through `strings` twice, UTF-8 and UTF-16LE, because a marker
# can live in a JS chunk, in a Dart AOT snapshot, in the dex string pool, in resources.arsc or in a
# compiled manifest. The check is deliberately on the artifact and not on the source tree: the
# minifier drops string literals of code it removes, and a marker that a bundler dropped is the same
# failure as a patch that never applied.
#
# Usage: check-markers.sh <artifact> <markers-file>
#   <artifact>      directory, .apk/.zip, .tar.gz or plain file to check
#   <markers-file>  `<patch-name><TAB><token>` lines from apply-patches.sh

set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <artifact> <markers-file>" >&2
    exit 2
}

[ "$#" -ge 2 ] || usage
artifact="$1"
markers="$2"
[ -e "$artifact" ] || { echo "::error::no artifact at $artifact" >&2; exit 2; }
[ -f "$markers" ] || { echo "::error::no marker list at $markers" >&2; exit 2; }

# A marker list with no entries would make every run green: that is the failure this gate exists to
# prevent, so it is an error rather than a pass.
if ! grep -qvE '^[[:space:]]*(#|$)' "$markers"; then
    echo "::error::$markers holds no markers: the gate would check nothing" >&2
    exit 1
fi

bytes="$(mktemp "${TMPDIR:-/tmp}/plotina-artifact.XXXXXX")"
text="$(mktemp "${TMPDIR:-/tmp}/plotina-artifact-strings.XXXXXX")"

if [ -d "$artifact" ]; then
    find "$artifact" -type f -exec cat {} + > "$bytes" 2>/dev/null || true
else
    magic="$(head -c 2 "$artifact" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    case "$magic" in
        504b)
            # A zip: unzip prints every entry to stdout. A file that starts like a zip but does not
            # read leaves nothing behind, which is caught below instead of passing every marker.
            unzip -p "$artifact" > "$bytes" 2>/dev/null || true
            ;;
        1f8b)
            tar -xzOf "$artifact" > "$bytes" 2>/dev/null || true
            ;;
        *)
            cat "$artifact" > "$bytes" 2>/dev/null || true
            ;;
    esac
fi

if [ ! -s "$bytes" ]; then
    echo "::error::$artifact could not be read as a directory, a zip, a tarball or a file — nothing" >&2
    echo "  was scanned, so no marker was checked. A gate that reads nothing is not green." >&2
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
            "$patch" "$token" "$(basename "$artifact")"
        missing=$((missing + 1))
        missing_report="${missing_report}    ${patch}  (\"${token}\")
"
    fi
done < "$markers"

if [ "$missing" -ne 0 ]; then
    echo "::error::$missing of $total applied patches are not in $(basename "$artifact"):" >&2
    printf '%s' "$missing_report" >&2
    echo "  The build compiled a tree without them. Check that every patches/*.patch applied and" >&2
    echo "  that the minifier did not drop the code that carries the marker." >&2
    exit 1
fi

printf 'markers: %d/%d present in %s\n' "$total" "$total" "$(basename "$artifact")"
