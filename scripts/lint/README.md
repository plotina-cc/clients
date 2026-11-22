# The diff-scoped lint gate: which rules, and why

`scripts/lint-patches.sh` runs four linters over **the lines our patches add** to the pinned
upstream tags. This file records what is enabled, what is deliberately not, and the measurement
behind each exclusion, so the next person can argue with a number instead of a feeling.

Every rule below was picked because it catches a defect class we have actually shipped or nearly
shipped. Nothing is enabled "for consistency", and nothing is excluded to make a run green: an
excluded rule that would have fired is named with the count it produced.

## Shell — ShellCheck `-S warning`, on `scripts/**/*.sh` and `*/scripts/**/*.sh`

Our gates are bash, and the failure mode we have hit is a gate that cannot fail. At `-S warning`
ShellCheck reports the classes that produce it:

| code | what it caught |
| --- | --- |
| SC2154 | a gate comparing a variable nothing ever assigns — the check is decoration |
| SC2164 | `cd` without `\|\| exit`: the rest of the script runs in the wrong directory |
| SC2043/SC2066 | a `for` loop that can only ever run once: the glob or the quoting is wrong |
| SC2034 | a variable nothing reads: usually a result that was never checked |

Style findings (SC2086 unquoted expansion, SC2001 `sed` vs parameter expansion) sit at the default
severity and are **not** reported: on our scripts they are 20+ findings about heredocs and
`$(ls)`-free loops, and a gate whose output is style is a gate people skip.

## Dart — `dart analyze` on the `.dart` files the fluffychat patches change

| rule | the defect |
| --- | --- |
| `unawaited_futures` | a Future dropped in an async body: the fire-and-forget whose failure reaches nobody |
| `discarded_futures` | the same in a sync body; Dart needs both, neither covers the other |
| `cancel_subscriptions` | a StreamSubscription nobody cancels: a listener outliving its screen |
| `close_sinks` | a StreamController/Sink nobody closes: a stream that never ends |
| `empty_catches` | `catch {}` — the exception is gone and nothing says why |

**`avoid_catches_without_on_clauses` is excluded despite the card naming it.** It was measured
first: 18 findings on our own lines, all 18 of the shape
`catch (e, s) { Logs().w('…', e, s); return fallback; }` — a catch that logs the error *and* the
stack, which is what an updater wants. The rule cannot tell that from a swallow; `empty_catches`
can, and finds zero on our code. Keeping both would mean 18 baseline entries describing correct
code, and a baseline nobody reads is a gate nobody reads.

`avoid_catching_errors` (flags `on Error catch`, right where it is used) is excluded on the card's
instruction. `avoid_print` and the rest of `flutter_lints` are style: on a file we edited three
lines of, they report hundreds of findings on lines we did not write.

## TypeScript/JS — ESLint, type-aware, on the `.ts`/`.tsx` the cinny and element-call patches change, plus our own JS overlays

| rule | the defect |
| --- | --- |
| `no-empty` (no `allowEmptyCatch`) | an empty block; `catch {}` is the case the default allows |
| `@typescript-eslint/no-floating-promises` | a Promise nobody awaits or catches |
| `@typescript-eslint/no-misused-promises` with `checksVoidReturn.attributes: false` | an async function passed where a void one is expected; `attributes: false` is what keeps React JSX handlers from being reported |

The type-aware rules need a type program, so the gate hands ESLint a scoped copy of the tree's own
tsconfig with `include` set to exactly our files (`scripts/lint/scope-tsconfig.py`). Without it,
element-call's `vite.config.ts` — which a patch edits and upstream's `include` does not cover — is a
parse error, and a batch that falls back to no type information reports **zero** for these rules,
which is the silent downgrade the gate must never have.

Upstream's `.eslintrc` is not used: it names plugins that are not installed in a patched checkout,
and `noInlineConfig` is on so an upstream `eslint-disable` comment cannot hide a finding.

## Kotlin — detekt 1.23.8 on the `.kt` files the element-x patches change

| rule | the defect |
| --- | --- |
| `SwallowedException` | a catch that drops the exception |
| `EmptyCatchBlock` | an empty catch block |
| `GlobalCoroutineUsage` | `GlobalScope` instead of a passed-in scope |
| `SuspendFunSwallowedCancellation` | a suspend function that loses cancellation |
| `SleepInsteadOfDelay` | `Thread.sleep` in coroutine code |

detekt's own defaults enable ~200 rules. `scripts/tests/detekt-config.py` derives the config from
the jar's own `--generate-config`, switches every rule off and these five back on, so a rule rename
between detekt versions cannot silently enable or disable the wrong thing. Two of the five need type
resolution and are silent without it — the coroutines jar is on the classpath for exactly that
reason, and the negative control fails the run when it is missing.

## What the gate reports and what it fails on

`upstream  path:line rule message` — a finding on a line **no patch touched**, in a file a patch did
change. Printed and counted, never a failure. This half is why a run is not "0 issues": it is the
noise we chose not to gate on, and it stays visible so it cannot quietly grow.

`OURS      path:line rule message` — a finding on a line our patches added or rewrote, or in a file
no patch touches (a wiring bug: the linter was pointed at our files). This is what can fail the run,
minus anything named in `scripts/lint/baseline.txt`.

## Baseline

`scripts/lint/baseline.txt` holds the findings we tolerate, keyed by file and line. Every entry has
the reason above it. An entry that stops occurring fails the run, so the list can only shrink; a
new finding on the same line under the same rule is a different entry and fails.

Current state on main (2026-11-22): shell 2, dart 7, ts 8, kotlin 0 — 17 tolerated findings, all
argued in the file. Everything else the gate finds on our lines is zero.
