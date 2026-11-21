#!/usr/bin/env bash
# Diff-scoped lint gate: lints the code *our patches* add, not the upstream tree they land in.
#
#   scripts/lint-patches.sh [--repo DIR] [--stack NAME ...] [--tree CLIENT=DIR ...]
#                           [--report-only] [--timeout SECONDS]
#
# Four stacks, one per language we write, each with the rules that catch the defect classes we have
# actually shipped (see the rule comments below and scripts/lint/analysis_options.lint.yaml):
#
#   shell    ShellCheck -S warning       scripts/**/*.sh, */scripts/**/*.sh  (our gates)
#   dart     dart analyze                .dart files the fluffychat patches change
#   ts       ESLint (type-aware)         .ts/.tsx from the cinny and element-call patches, plus our
#                                        own JS overlays (element-web, cinny-electron)
#   kotlin   detekt                      .kt files the element-x patches change
#
# Three properties this script is built around, each of them a bug we would otherwise ship:
#
# 1. Only our lines. A patched file is upstream's file with our hunks in it, so a file-scoped
#    linter reports upstream's floating promises next to ours. scripts/lint/findings.py splits the
#    findings by line using the diff the applied patches produced; only "ours" can fail the run,
#    and the upstream count is printed so it cannot grow unnoticed.
#
# 2. A missing linter is an error, never a pass. `command -v shellcheck || exit 0` is how a gate
#    becomes decoration: it is green on every runner that lacks the tool.
#
# 3. Known findings live in a checked-in baseline, not in a config switch. Every entry is a line in
#    scripts/lint/baseline.txt with the reason it is tolerated; the gate fails on a finding that is
#    not in it, and fails again when an entry stops being needed, so the list can only shrink.
#    Nothing is silenced by turning a rule off — a rule that does not fire cannot catch anything.
#
# Exit: 0 clean, 1 findings of ours, 2 usage / missing tool / broken input.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"
stacks=()
trees=()
report_only=0
timeout_s="${LINT_TIMEOUT:-120}"

usage() {
    cat << 'USAGE'
usage: lint-patches.sh [options]

  --repo DIR              repository root (default: the parent of this script)
  --stack NAME            shell | dart | ts | kotlin (repeatable; default: all four)
  --tree CLIENT=DIR       an upstream checkout with this repository's patches applied, for CLIENT.
                          Needed by the dart stack (fluffychat=...) and the kotlin stack
                          (element-x=...); the ts stack uses it for cinny=/element-call= when given,
                          otherwise lints only the overlays this repository owns.
  --report-only           print findings, always exit 0 (used to measure a stack before gating on it)
  --timeout SECONDS       per-linter wall clock (default 120, or $LINT_TIMEOUT)

Tools, overridable by environment when the runner keeps them outside PATH:
  LINT_SHELLCHECK, LINT_DART, LINT_ESLINT, LINT_TS_MODULES, LINT_DETEKT, LINT_DETEKT_CLASSPATH
USAGE
}

die() { printf '::error::%s\n' "$*" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo) repo="${2:-}"; shift 2 ;;
        --stack) stacks+=("${2:-}"); shift 2 ;;
        --tree) trees+=("${2:-}"); shift 2 ;;
        --report-only) report_only=1; shift ;;
        --timeout) timeout_s="${2:-}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown argument: $1 (see --help)" ;;
    esac
done

[ -d "$repo" ] || die "--repo is not a directory: $repo"
repo="$(cd "$repo" && pwd)"
[ "${#stacks[@]}" -gt 0 ] || stacks=(shell dart ts kotlin)

for stack in "${stacks[@]}"; do
    case "$stack" in
        shell|dart|ts|kotlin) ;;
        *) die "unknown stack: $stack (shell, dart, ts, kotlin)" ;;
    esac
done

# Support files live next to this script, not under --repo: --repo is the tree being linted (a
# fixture in the tests, this repository in CI), and resolving them through it would make the gate
# depend on the checked-out tree for its own rules.
findings_py="$here/lint/findings.py"
baseline="$here/lint/baseline.txt"
[ -f "$findings_py" ] || die "missing $findings_py"

work="$(mktemp -d "${TMPDIR:-/tmp}/plotina-lint.XXXXXX")" || die "cannot create a work directory"
trap 'find "$work" -mindepth 1 -delete 2>/dev/null; rmdir "$work" 2>/dev/null' EXIT

# tree_for <client> — the checkout for a client, if the caller passed one.
tree_for() {
    local wanted="$1" entry
    for entry in "${trees[@]}"; do
        case "$entry" in
            "$wanted"=*) printf '%s' "${entry#*=}"; return 0 ;;
        esac
    done
    return 1
}

# uses_baseline / bump <key> — a finding is tolerated only if the baseline says so, and a baseline
# entry that stops being needed is an error: a list nobody shrinks stops describing the code.
found_keys="$work/found-keys"
: > "$found_keys"

verdict=0
total_ours=0

finish_stack() {
    local stack="$1" ours="$2"
    total_ours=$((total_ours + ours))
}

# stack_roots <stack> — every tree this stack's findings can come from. A baseline entry is
# "current" when its file exists in one of them; when none of them has the file, the entry belongs to
# a tree that is not being linted right now (a fixture run, a client checked out without its
# upstream) and calling it stale would make the gate red for the wrong reason.
stack_roots() {
    local stack="$1" client
    printf '%s\n' "$repo"
    case "$stack" in
        dart) tree_for fluffychat 2>/dev/null || true ;;
        kotlin) tree_for element-x 2>/dev/null || true ;;
        ts)
            for client in cinny element-call; do
                tree_for "$client" 2>/dev/null || true
            done
            ;;
    esac
}

# check_baseline <stack> — compare this stack's key file with the baseline section for it.
check_baseline() {
    local stack="$1"
    local known="$work/known-$stack" found="$work/found-$stack"
    : > "$known"; : > "$found"

    if [ -f "$baseline" ]; then
        awk -v stack="$stack" '
            /^[[:space:]]*#/ { next }
            /^[[:space:]]*$/ { next }
            { split($0, f, "|"); if (f[1] == stack) print $0 }
        ' "$baseline" | sort > "$work/known-all-$stack"
        local roots
        mapfile -t roots < <(stack_roots "$stack")
        while IFS= read -r entry; do
            local path root present=0
            path="$(printf '%s' "$entry" | sed 's/^[^|]*|//' | sed 's/:[0-9].*$//')"
            for root in "${roots[@]}"; do
                [ -n "$root" ] && [ -e "$root/$path" ] && present=1 && break
            done
            [ "$present" -eq 1 ] && printf '%s\n' "$entry"
        done < "$work/known-all-$stack" > "$known"
    fi

    grep "^$stack|" "$found_keys" 2>/dev/null | sort > "$found" || : > "$found"

    local new
    new="$(comm -13 "$known" "$found")"
    local stale
    stale="$(comm -23 "$known" "$found")"

    if [ -n "$new" ]; then
        printf '\n%s: findings not in scripts/lint/baseline.txt:\n' "$stack"
        printf '%s\n' "$new" | sed 's/^/  + /'
        [ "$report_only" -eq 1 ] || verdict=1
    fi
    if [ -n "$stale" ]; then
        printf '\n%s: baseline entries that no longer occur — shrink scripts/lint/baseline.txt:\n' "$stack"
        printf '%s\n' "$stale" | sed 's/^/  - /'
        [ "$report_only" -eq 1 ] || verdict=1
    fi
    local n_known n_found
    n_known="$(grep -c . "$known" 2>/dev/null || true)"
    n_found="$(grep -c . "$found" 2>/dev/null || true)"
    printf '%s: %s finding(s), %s already in the baseline\n' "$stack" "${n_found:-0}" "${n_known:-0}"
}

# --- shell --------------------------------------------------------------------------------------
#
# Our gates are bash, and a gate that cannot fail is a bug class of its own: `[ $x = y ] && ok`
# as the last line of a script, an unquoted comparison, a `cd` that silently leaves the script in
# the wrong directory. ShellCheck -S warning keeps exactly those; at the default severity it also
# reports style (SC2086 quoting in every heredoc), which is where a shell gate loses its audience.
stack_shell() {
    local tool="${LINT_SHELLCHECK:-}"
    if [ -z "$tool" ]; then
        tool="$(command -v shellcheck || true)"
    fi
    [ -n "$tool" ] && [ -x "$tool" ] \
        || die "no shellcheck found: set LINT_SHELLCHECK or put shellcheck on PATH (a missing linter is not a pass)"

    local files=()
    while IFS= read -r file; do
        case "$file" in
            # `*` in a case pattern matches `/` too, so one pattern covers scripts/a.sh and
            # scripts/tests/a.sh alike; a second nested pattern would be dead weight.
            scripts/*.sh|*/scripts/*.sh) files+=("$file") ;;
        esac
    done < <(git -C "$repo" ls-files '*.sh')

    if [ "${#files[@]}" -eq 0 ]; then
        printf 'shell: no scripts/*.sh in %s — nothing to lint\n' "$repo"
        return 0
    fi
    printf 'shell: %s script(s), ShellCheck -S warning\n' "${#files[@]}"

    local json="$work/shellcheck.json"
    ( cd "$repo" && timeout "$timeout_s" "$tool" -S warning -f json1 "${files[@]}" ) > "$json" 2> "$work/shellcheck.err"
    local rc=$?
    # The linter exits 1 when it has findings and 0 when clean; anything else is a broken run.
    if [ "$rc" -gt 1 ]; then
        printf 'shellcheck failed (exit %s):\n' "$rc" >&2
        sed 's/^/  /' "$work/shellcheck.err" >&2
        exit 2
    fi

    # Our own shell files are entirely ours — no patch hunk decides where they start, they are new
    # files in this repository — so the added-lines file covers each of them whole. Using a diff
    # here would additionally narrow them to whatever the current branch changed, and a finding on
    # line 40 of a script we wrote last month would then be nobody's.
    all_lines "$repo" "${files[@]}" > "$work/shell-added.txt"

    local out
    out="$(python3 "$findings_py" report --format shellcheck --added "$work/shell-added.txt" \
        --label shell --root "$repo" < "$json")"
    local prc=$?
    printf '%s\n' "$out" | grep -v 'on our lines'
    record_keys shell "$out"
    return $(( prc == 0 ? 0 : 1 ))
}

# all_lines <tree> <relative paths...> — an added-lines file covering whole files.
all_lines() {
    local tree="$1"; shift
    local file
    for file in "$@"; do
        local n
        n="$(wc -l < "$tree/$file")"
        printf '%s\t1-%s\n' "$file" "$(( n > 0 ? n : 1 ))"
    done
}

# patched_files <tree> — `<relative path>\t<added ranges>` for a tree the patches were applied to.
patched_files() {
    local tree="$1" out="$2"
    python3 "$findings_py" added "$tree" > "$out" || die "cannot read the change set of $tree"
}

# --- dart ---------------------------------------------------------------------------------------
#
# flutter analyze / dart analyze on the files our fluffychat patches change, with the five rules in
# scripts/lint/analysis_options.lint.yaml. The whole app is not analysed: on a patched upstream
# tree that is minutes and hundreds of upstream findings, and the card's rule is only about lines
# we wrote.
stack_dart() {
    local tree
    tree="$(tree_for fluffychat || true)"
    if [ -z "$tree" ]; then
        die "the dart stack needs --tree fluffychat=DIR (an upstream checkout with the patches applied)"
    fi
    [ -d "$tree" ] || die "--tree fluffychat=$tree is not a directory"

    local tool="${LINT_DART:-}"
    [ -n "$tool" ] || tool="$(command -v dart || true)"
    [ -n "$tool" ] && [ -x "$tool" ] || die "no dart found: set LINT_DART or put the Flutter SDK on PATH"

    local added="$work/dart-added.txt"
    patched_files "$tree" "$added"
    local files=()
    while IFS=$'\t' read -r path _; do
        case "$path" in *.dart) files+=("$path") ;; esac
    done < "$added"
    if [ "${#files[@]}" -eq 0 ]; then
        printf 'dart: the fluffychat patches change no .dart file — nothing to lint\n'
        return 0
    fi
    printf 'dart: %s file(s), 5 lint rules\n' "${#files[@]}"

    # The lint rules have to come from us, not from upstream's analysis_options.yaml: that file
    # enables ~30 style rules and an analyzer plugin that needs its own pub upgrade on every cold
    # run. The tree is a throwaway checkout, so the file is replaced, not edited in place. No guard
    # on .dart_tool: if the dependencies are not resolved, `dart analyze` says so on the next line,
    # and a silent skip here would be the "gate that checks nothing" this script exists to avoid.
    if [ -f "$here/lint/analysis_options.lint.yaml" ]; then
        cp "$here/lint/analysis_options.lint.yaml" "$tree/analysis_options.yaml"
    else
        die "missing $here/lint/analysis_options.lint.yaml — the dart stack would run upstream's rules"
    fi

    local machine="$work/dart.txt"
    ( cd "$tree" && timeout "$timeout_s" "$tool" analyze --format machine "${files[@]}" ) > "$machine" 2> "$work/dart.err"
    local rc=$?
    # dart analyze: 0 clean, 1/2/3 findings by severity, 4+ tool failure.
    if [ "$rc" -gt 3 ]; then
        printf 'dart analyze failed (exit %s):\n' "$rc" >&2
        sed 's/^/  /' "$work/dart.err" >&2
        exit 2
    fi

    local out prc
    out="$(python3 "$findings_py" report --format dart --added "$added" --label dart --root "$tree" \
        --rule UNAWAITED_FUTURES --rule DISCARDED_FUTURES --rule CANCEL_SUBSCRIPTIONS \
        --rule CLOSE_SINKS --rule EMPTY_CATCHES < "$machine")"
    prc=$?
    printf '%s\n' "$out"
    record_keys dart "$out"
    return $(( prc == 0 ? 0 : 1 ))
}

# record_keys <stack> <report output> — the findings of ours, as baseline keys.
record_keys() {
    local stack="$1" out="$2" line key
    while IFS= read -r line; do
        case "$line" in
            "OURS      "*)
                key="$(printf '%s' "$line" | sed 's/^OURS      //' | awk '{print $1, $2}')"
                printf '%s|%s\n' "$stack" "$key" >> "$found_keys"
                ;;
        esac
    done <<< "$out"
}

# --- ts -----------------------------------------------------------------------------------------
#
# ESLint over the .ts/.tsx our cinny and element-call patches change, plus the JavaScript overlays
# this repository owns outright (element-web's plotina-*.js, the cinny-electron shell). Type-aware
# rules need a tsconfig, so a patched tree contributes its own; an overlay file has no project and
# gets the rules that do not need one (no-empty).
stack_ts() {
    local eslint="${LINT_ESLINT:-}"
    if [ -z "$eslint" ]; then
        local modules="${LINT_TS_MODULES:-}"
        if [ -n "$modules" ] && [ -x "$modules/.bin/eslint" ]; then
            eslint="$modules/.bin/eslint"
        fi
    fi
    [ -n "$eslint" ] || eslint="$(command -v eslint || true)"
    [ -n "$eslint" ] && [ -x "$eslint" ] \
        || die "no eslint found: install it (npm i eslint typescript typescript-eslint) and set LINT_ESLINT or LINT_TS_MODULES"

    local config="$here/lint/eslint.config.mjs"
    [ -f "$config" ] || die "missing $config"

    # Where `typescript-eslint` lives. The config file is in this repository; the package is
    # installed wherever the runner put eslint. Resolving from a checkout that only has upstream's
    # old @typescript-eslint would pick up v5 and lose the type-aware rules silently.
    local ts_module="${LINT_TS_ESLINT_MODULE:-}"
    if [ -z "$ts_module" ]; then
        local guess
        guess="$(cd "$(dirname "$eslint")/.." 2>/dev/null && pwd)/typescript-eslint"
        [ -d "$guess" ] && ts_module="$guess"
    fi
    [ -n "$ts_module" ] || die "cannot find the typescript-eslint package: set LINT_TS_ESLINT_MODULE to its directory"

    local rc_all=0 out prc
    local patched=0
    local client
    for client in cinny element-call; do
        local tree
        tree="$(tree_for "$client" || true)"
        [ -n "$tree" ] || continue
        [ -d "$tree" ] || die "--tree $client=$tree is not a directory"
        patched=1

        local added="$work/ts-added-$client.txt"
        patched_files "$tree" "$added"
        local files=()
        while IFS=$'\t' read -r path _; do
            case "$path" in *.ts|*.tsx) files+=("$path") ;; esac
        done < "$added"
        if [ "${#files[@]}" -eq 0 ]; then
            printf 'ts/%s: the patches change no .ts/.tsx file\n' "$client"
            continue
        fi
        printf 'ts/%s: %s file(s), type-aware\n' "$client" "${#files[@]}"

        local project=""
        [ -f "$tree/tsconfig.json" ] && project=./tsconfig.json
        # No tsconfig in a patched tree means the type-aware rules cannot run, and ESLint would
        # then report an empty result for those files — a gate silently downgraded to no-empty. A
        # sparse checkout that skipped tsconfig.json did exactly that before this check existed.
        [ -n "$project" ] \
            || die "$client has no tsconfig.json at $tree: the type-aware rules cannot run, and a silent downgrade is not a lint"

        # A file outside the project's `include` cannot be type-checked, and @typescript-eslint
        # reports that as a parse error on the file — which would make the gate red on a file the
        # patches legitimately touch (element-call's vite.config.ts is outside its include list) and
        # green on nothing in it. So the project handed to the linter is a copy of the tree's own
        # tsconfig with `include` replaced by exactly our files: everything we pass gets a type
        # program, and a file the tree's config excluded deliberately is still type-checked on its
        # own terms.
        #
        # The scoped file is written *into* the tree, next to the tsconfig it derives from: `include`
        # and `paths` in a tsconfig are relative to its own directory, so a copy anywhere else would
        # silently resolve nothing (measured: TS18003 "No inputs were found").
        local scoped="$tree/tsconfig.plotina-lint.json"
        python3 "$here/lint/scope-tsconfig.py" "$tree/tsconfig.json" "${files[@]}" > "$scoped" \
            || die "cannot write a scoped tsconfig for $client"
        printf 'ts/%s: tsconfig scoped to our %s file(s)\n' "$client" "${#files[@]}"

        out="$(cd "$tree" && PLOTINA_TS_PROJECT="./tsconfig.plotina-lint.json" PLOTINA_TS_ROOT="$tree" \
            PLOTINA_TS_ESLINT_MODULE="$ts_module" \
            timeout "$timeout_s" "$eslint" --no-config-lookup --config "$config" --format json "${files[@]}" 2>"$work/eslint-$client.err")"
        prc=$?
        rm -f "$scoped"
        if [ "$prc" -gt 1 ] && [ "$prc" -ne 124 ]; then
            printf 'eslint failed on %s (exit %s):\n' "$client" "$prc" >&2
            sed 's/^/  /' "$work/eslint-$client.err" >&2
            exit 2
        fi
        local report
        report="$(printf '%s' "$out" | python3 "$findings_py" report --format eslint --added "$added" \
            --label "ts/$client" --root "$tree" --rule no-empty \
            --rule @typescript-eslint/no-floating-promises --rule @typescript-eslint/no-misused-promises)"
        prc=$?
        printf '%s\n' "$report"
        record_keys ts "$report"
        [ "$prc" -eq 0 ] || rc_all=1
    done

    # Our own overlays. These files are not upstream's at all, so every line in them is ours.
    # noise/ is the denoiser layer that ships inside every web bundle; element-web's plotina-*.js
    # is the aliases/theme code the image serves; cinny-electron/src is the Electron shell.
    # noise/vendor/ is excluded on purpose: dfn.esm.js and dpdfnet.esm.js are third-party bundles
    # (a vendored copy of someone else's library, digest-pinned in noise/*.lock.json), and linting
    # a vendored file reports its author's style as our defect.
    local overlays=()
    while IFS= read -r file; do
        case "$file" in
            noise/vendor/*) continue ;;
            noise/*.js|element-web/plotina-*.js|cinny-electron/src/*.js|cinny-electron/src/*.mjs)
                overlays+=("$file") ;;
        esac
    done < <(git -C "$repo" ls-files '*.js' '*.mjs')
    if [ "${#overlays[@]}" -gt 0 ]; then
        printf 'ts/overlays: %s file(s), syntax scope\n' "${#overlays[@]}"
        local added_all="$work/overlay-added.txt"
        all_lines "$repo" "${overlays[@]}" > "$added_all"
        out="$(cd "$repo" && PLOTINA_TS_PROJECT='' PLOTINA_TS_ROOT="$repo" PLOTINA_TS_ESLINT_MODULE="$ts_module" \
            timeout "$timeout_s" "$eslint" --no-config-lookup --config "$config" --format json "${overlays[@]}" 2>"$work/eslint-overlays.err")"
        prc=$?
        if [ "$prc" -gt 1 ] && [ "$prc" -ne 124 ]; then
            printf 'eslint failed on the overlays (exit %s):\n' "$prc" >&2
            sed 's/^/  /' "$work/eslint-overlays.err" >&2
            exit 2
        fi
        local report
        report="$(printf '%s' "$out" | python3 "$findings_py" report --format eslint \
            --added "$added_all" --label ts/overlays --root "$repo" --rule no-empty)"
        prc=$?
        printf '%s\n' "$report"
        record_keys ts "$report"
        [ "$prc" -eq 0 ] || rc_all=1
    fi

    [ "$patched" -eq 1 ] || printf 'ts: no --tree cinny=/element-call= given; only the overlays were linted\n'
    return "$rc_all"
}

# --- kotlin -------------------------------------------------------------------------------------
#
# detekt on the .kt files our element-x patches change, with five rules: a swallowed exception, an
# empty catch, GlobalScope, a suspend fun that loses cancellation, and Thread.sleep in coroutine
# code. detekt's default rule set is ~200 rules — MagicNumber, naming, complexity — and on a
# patched tree that is noise about code we did not write.
stack_kotlin() {
    local tree
    tree="$(tree_for element-x || true)"
    if [ -z "$tree" ]; then
        die "the kotlin stack needs --tree element-x=DIR (an upstream checkout with the patches applied)"
    fi
    [ -d "$tree" ] || die "--tree element-x=$tree is not a directory"

    local jar="${LINT_DETEKT:-}"
    [ -n "$jar" ] || die "no detekt found: set LINT_DETEKT to detekt-cli-<version>-all.jar"
    [ -f "$jar" ] || die "LINT_DETEKT=$jar is not a file"
    command -v java >/dev/null 2>&1 || die "no java on PATH (detekt is a JVM tool)"

    local added="$work/kotlin-added.txt"
    patched_files "$tree" "$added"
    local files=()
    while IFS=$'\t' read -r path _; do
        case "$path" in
            *.kt)
                # Test sources are Kotlin too, and a swallowed exception in a test hides a failing
                # assertion path just as well. Both are linted.
                files+=("$path")
                ;;
        esac
    done < "$added"
    if [ "${#files[@]}" -eq 0 ]; then
        printf 'kotlin: the element-x patches change no .kt file — nothing to lint\n'
        return 0
    fi
    printf 'kotlin: %s file(s), 5 detekt rules\n' "${#files[@]}"

    # detekt's own defaults, every rule off but ours — derived from the jar into the work dir so the
    # rule names match the version that runs, not a copy pasted from a release a year old. Nothing is
    # written into the repository: a gate that edits a tracked file is a gate that leaves a dirty
    # tree behind on the runner.
    local config="$work/detekt.yml"
    ( cd "$work" && java -jar "$jar" --generate-config >/dev/null 2>&1 ) \
        || die "detekt could not write its default config"
    python3 "$here/tests/detekt-config.py" "$work/detekt.yml" "$config" >/dev/null \
        || die "cannot derive $config from detekt's defaults"

    local input
    input="$(IFS=,; printf '%s' "${files[*]}")"
    local classpath="${LINT_DETEKT_CLASSPATH:-}"
    local cp_args=()
    [ -n "$classpath" ] && cp_args=(--classpath "$classpath")

    local report="$work/detekt.txt"
    local out
    # --jdk-home is only passed when it is set: `--jdk-home ""` makes detekt look for a JDK in the
    # empty string instead of using the one it runs on.
    local jdk_args=()
    [ -n "${JAVA_HOME:-}" ] && jdk_args=(--jdk-home "$JAVA_HOME")

    out="$(cd "$tree" && timeout "$timeout_s" java -Xmx1g -jar "$jar" \
        "${jdk_args[@]}" "${cp_args[@]}" --config "$config" --input "$input" 2>&1)"
    local rc=$?
    printf '%s\n' "$out" | grep -E ':[0-9]+:[0-9]+: .*\[[A-Za-z]+\]$' > "$report" || true
    # detekt exits 2 when it has findings (maxIssues: 0), 0 when clean, 3 on a broken run.
    if [ "$rc" -gt 2 ]; then
        printf 'detekt failed (exit %s):\n' "$rc" >&2
        printf '%s\n' "$out" | sed 's/^/  /' >&2
        exit 2
    fi

    local result prc
    result="$(python3 "$findings_py" report --format detekt --added "$added" --label kotlin --root "$tree" \
        --rule SwallowedException --rule EmptyCatchBlock --rule GlobalCoroutineUsage \
        --rule SuspendFunSwallowedCancellation --rule SleepInsteadOfDelay < "$report")"
    prc=$?
    printf '%s\n' "$result"
    record_keys kotlin "$result"
    return $(( prc == 0 ? 0 : 1 ))
}

# --- run ----------------------------------------------------------------------------------------

: > "$work/all-lines.txt"

started="$(date +%s)"
# A stack returning non-zero means it found something on our lines; the baseline comparison below
# is what decides the verdict, because a finding that is in the baseline is a pass. So the stack
# results are collected for the log and nothing more — deriving the verdict from them would fail
# every run that has a single tolerated finding.
failed_stacks=()
for stack in "${stacks[@]}"; do
    printf '\n== %s\n' "$stack"
    case "$stack" in
        shell) stack_shell || failed_stacks+=("$stack") ;;
        dart) stack_dart || failed_stacks+=("$stack") ;;
        ts) stack_ts || failed_stacks+=("$stack") ;;
        kotlin) stack_kotlin || failed_stacks+=("$stack") ;;
    esac
done
elapsed=$(( $(date +%s) - started ))

printf '\n== baselines\n'
for stack in "${stacks[@]}"; do
    check_baseline "$stack"
done

printf '\n%s stack(s) in %ss\n' "${#stacks[@]}" "$elapsed"

if [ "$report_only" -eq 1 ]; then
    printf 'report-only: exit 0 regardless of findings\n'
    exit 0
fi
[ "$verdict" -eq 0 ] || {
    printf 'result: new findings on our lines (see the + lines above)\n'
    exit 1
}
printf 'result: clean — every finding on our lines is in scripts/lint/baseline.txt\n'
exit 0
