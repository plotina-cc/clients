#!/usr/bin/env bash
# Applies every Plotina patch to an upstream Element X checkout — the only way patches reach the
# tree. build-element-x.yml and validate-element-x.yml both call this; neither keeps a list of its
# own, because a hand-maintained list is exactly how patch 0016 sat in patches/ and never made it
# into the .32-dev.4 APK: the workflow named thirteen patches and the fourteenth was invisible to
# everyone until the owner saw logins instead of names on his phone.
#
# What it guarantees:
#   * every patches/*.patch is applied, in LC_ALL=C byte order (verified safe: no patch depends on
#     a later one, see the ordering analysis in the patch review);
#   * each patch is `git apply --check`ed against the tree the previous patches built, so a stale
#     patch fails here in seconds instead of somewhere inside a 30-minute Gradle run;
#   * the run is refused when the applied count does not equal the file count, when a .rej is left
#     behind, or when a patch carries no `# Plotina-Marker:` header — a patch the artifact gate
#     cannot verify is a patch nobody verifies;
#   * the marker tokens of the *applied* patches are written to a file that check-markers.sh reads
#     after the build, so the APK is checked against what actually went in, not against a list.
#
# Usage: apply-patches.sh <upstream-dir> [markers-file]
#   <upstream-dir>   checkout of element-x-android at the pinned tag
#   [markers-file]   where to write `<patch-name><TAB><token>` lines (default ./plotina-markers.txt)

set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <upstream-dir> [markers-file]" >&2
    exit 2
}

[ "$#" -ge 1 ] || usage
upstream="$1"
[ -d "$upstream" ] || { echo "::error::$upstream is not a directory" >&2; exit 2; }
markers="${2:-$PWD/plotina-markers.txt}"

git -C "$upstream" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { echo "::error::$upstream is not a git checkout: git apply needs a work tree" >&2; exit 2; }

scripts_dir="$(cd "$(dirname "$0")" && pwd)"
patches_dir="$(cd "$scripts_dir/../patches" && pwd)"

patches=()
while IFS= read -r patch; do
    patches+=("$patch")
done < <(find "$patches_dir" -maxdepth 1 -type f -name '*.patch' | LC_ALL=C sort)

total="${#patches[@]}"
if [ "$total" -eq 0 ]; then
    echo "::error::no *.patch files in $patches_dir: refusing to report a patched tree" >&2
    exit 1
fi

err="$(mktemp "${TMPDIR:-/tmp}/plotina-apply.XXXXXX")"
: > "$markers"
applied=0

for patch in "${patches[@]}"; do
    name="$(basename "$patch" .patch)"
    marker="$(sed -n 's/^# Plotina-Marker:[[:space:]]*//p' "$patch" | head -n 1)"
    if [ -z "$marker" ]; then
        echo "::error::patches/$name.patch has no '# Plotina-Marker: <token>' header." >&2
        echo "  Every patch must name a string the built APK will contain, or the artifact gate" >&2
        echo "  cannot tell whether this patch reached the build." >&2
        exit 1
    fi
    # The marker has to be introduced by the patch itself (its header line aside): a token that no
    # hunk adds would be satisfied by context lines and prove nothing about the APK.
    if ! awk -v marker="$marker" '
        /^\+/ && index($0, marker) { found = 1 }
        END { exit(found ? 0 : 1) }
    ' "$patch"; then
        echo "::error::patches/$name.patch declares marker '$marker' but no added line contains it." >&2
        exit 1
    fi

    if ! git -C "$upstream" apply --check "$patch" 2> "$err"; then
        echo "::error::patches/$name.patch does not apply to $upstream:" >&2
        sed 's/^/    /' "$err" >&2
        exit 1
    fi
    git -C "$upstream" apply "$patch"

    printf 'applied: %s\n' "$name"
    printf 'marker: %s -> %s\n' "$name" "$marker"
    printf '%s\t%s\n' "$name" "$marker" >> "$markers"
    applied=$((applied + 1))
done

rejects="$(find "$upstream" -name '*.rej' -not -path '*/.git/*' -print)"
if [ -n "$rejects" ]; then
    echo "::error::rejected hunks left in the tree — the build would compile an unpatched file:" >&2
    printf '%s\n' "$rejects" | sed 's/^/    /' >&2
    exit 1
fi

if [ "$applied" -ne "$total" ]; then
    echo "::error::applied $applied patch(es) but $patches_dir holds $total: something was skipped" >&2
    exit 1
fi

printf 'applied: %d/%d\n' "$applied" "$total"
printf 'markers: %s (%d token(s))\n' "$markers" "$total"
