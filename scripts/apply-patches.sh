#!/usr/bin/env bash
# Applies every Plotina patch of a client to an upstream checkout — the only way patches reach a
# build tree in this repository. cinny, fluffychat and element-call call it from their workflows and
# from their local build scripts; none of them keeps a list of patch file names of its own.
#
# Why a script instead of the `for patch in patches/*.patch` loop each workflow used to have: a glob
# loop is quiet when it matches nothing, quiet when the patch directory is one level off, and quiet
# about a patch that applies but whose code never reaches the artifact. Element X shipped
# .32-dev.4 without patch 0016 exactly that way — a green build, an APK without the change.
#
# What it guarantees:
#   * every <client-dir>/patches/*.patch is applied, in LC_ALL=C byte order, and nothing else is:
#     a stray .patch inside the upstream tree is never touched;
#   * each patch is `git apply --check`ed against the tree the previous patches built, so a stale
#     patch fails here in seconds instead of inside a long Gradle/pnpm/Flutter run;
#   * the run is refused when the applied count differs from the directory, when a patch leaves a
#     .rej behind, or when a patch carries no `# Plotina-Marker:` header — a patch the artifact gate
#     cannot verify is a patch nobody verifies;
#   * the marker gets to be a lie only until the artifact exists: it must appear on a line the
#     patch *adds*, or a context line would satisfy the gate without the change being there;
#   * the marker tokens of the applied patches go to a file that check-markers.sh reads after the
#     build, so the artifact is checked against what really went in, not against a list.
#
# Usage: apply-patches.sh <client-dir> <upstream-dir> [markers-file]
#   <client-dir>     the client directory holding patches/ (cinny, fluffychat, element-call, ...)
#   <upstream-dir>   checkout of the client's upstream at the pinned tag
#   [markers-file]   where to write `<patch-name><TAB><token>` lines (default ./plotina-markers.txt)

set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <client-dir> <upstream-dir> [markers-file]" >&2
    exit 2
}

[ "$#" -ge 2 ] || usage
client="$(cd "$1" && pwd)" 2>/dev/null || { echo "::error::$1 is not a directory" >&2; exit 2; }
upstream="$2"
[ -d "$upstream" ] || { echo "::error::$upstream is not a directory" >&2; exit 2; }
markers="${3:-$PWD/plotina-markers.txt}"

patches_dir="$client/patches"
[ -d "$patches_dir" ] || {
    echo "::error::no patches/ directory in $client" >&2
    echo "  This client's patches live in <client-dir>/patches; a missing directory is a wiring" >&2
    echo "  mistake, and treating it as 'no patches to apply' is how a build ships unpatched." >&2
    exit 1
}

git -C "$upstream" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { echo "::error::$upstream is not a git checkout: git apply needs a work tree" >&2; exit 2; }

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
        echo "::error::$name.patch has no '# Plotina-Marker: <token>' header." >&2
        echo "  Every patch must name a string the built artifact will contain, or the artifact gate" >&2
        echo "  cannot tell whether this patch reached the build." >&2
        exit 1
    fi
    # The marker has to be introduced by the patch itself (its header line aside): a token that no
    # hunk adds would be satisfied by context lines and prove nothing about the artifact.
    if ! awk -v marker="$marker" '
        /^\+/ && index($0, marker) { found = 1 }
        END { exit(found ? 0 : 1) }
    ' "$patch"; then
        echo "::error::$name.patch declares marker '$marker' but no added line contains it." >&2
        exit 1
    fi

    if ! git -C "$upstream" apply --check "$patch" 2> "$err"; then
        echo "::error::$name.patch does not apply to $upstream:" >&2
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
