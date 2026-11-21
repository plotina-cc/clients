# Quality standard: what "works" has to mean here

Read in three minutes. This is the checklist a reviewer opens instead of re-explaining what evidence a card
needs; when a card is short of proof, point at the section number here.

Each client is an upstream release plus a patch layer. That shape makes two mistakes cheap and invisible: a
change that never reaches the artifact, and a test that proves the source text instead of the behaviour.
Sections 1 and 3 exist for those two.

## 1. Red-Green, and no decorative tests

**1.1 Red first.** Every bug fix or feature starts with a test that fails on the current code and reproduces
the symptom. The card (or commit) carries the failing command and its exact output — `Expected … / Actual …`
— from **before** the fix, then the same command passing after. A test written after the fix passes on the
broken tree too and proves nothing.

**1.2 Reading the source as text is not a test.** `readAsStringSync()` + `assertIn(…, src)`, grepping a file
for a function name, diffing two copies of the same string — none of it shows that input and output agree,
only that a word is present. A call site in the text can pass a wrong argument and the assertion stays green.

The one exception is a static audit of an invariant (a marker must be inside a patch, a manifest field must
have a value). It counts only beside a **negative control**: the same check fed a deliberately forbidden
line, failing with a non-zero exit. A gate that has never failed on anything is decoration.

**1.3 Round-trip rule.** A lifecycle test must build its state with the **production creation function**,
never a hand-written fixture. Create → edit → cancel, show → dismiss, write → read `account_data`: drive the
first step through the real code, assert on the last.

Our own defect, not theory: notifications were cancelled under an id computed on the receiving side while the
shown notification used another. Both sides had tests, both were green, the notification stayed on the shade
— each test had been handed its own fixture, so their ids never had to agree. Wherever a test has two ends,
one end must produce what the other consumes.

## 2. Thin native wrapper

Platform callbacks are where logic becomes untestable: FCM handlers, `Activity`/`Fragment` callbacks, Electron
IPC handlers, `FutureBuilder(initialData: …)` see their input once, cannot be called from a host test, and are
reached only on a device.

So decisions live outside them. The callback parses nothing, computes nothing, decides nothing — it hands the
platform object to a plain function and returns the result. Anything that *decides* is a function taking the
platform interface as an argument: computing an id, filtering the shade, parsing a manifest, choosing an
updater channel, resolving a display name. Those run in a host test with a fake interface — no emulator, no
device, no network.

A callback's test then has two halves: the function (real behaviour, fakes) and the wiring (one assertion that
the callback calls it). The wiring half is the only place where "it is called" is acceptable — there the call
*is* the contract.

## 3. Minimum evidence, by kind of change

Eight levels, from "the patch landed" to "a human tried it". None proves the one below it.

| # | Level | Proves |
|---|---|---|
| L1 | patch applies | `scripts/apply-patches.sh` on a clean upstream tree: ordered, counted, no `.rej`, marker on an added line |
| L2 | the gates themselves | `scripts/tests/run-tests.sh` cases on fixtures: no upstream, no toolchain, no network |
| L3 | change is in the artifact | `scripts/check-markers.sh` finds each applied patch's marker *inside* the built directory, APK/zip, tarball or single-file bundle |
| L4 | artifact composition | the files the change needs are there: `.so`, asset, class in dex, string table entry |
| L5 | configuration builds | patches apply, overlays land, Gradle/CMake configure — not one class compiled |
| L6 | harness code and smoke | unit/node/python suites of the wrapper, container and headless smokes |
| L7 | e2e over the wire | Playwright against a live deployment with a fake microphone, protocol runs |
| L8 | human QA | a person on the shipped artifact |

Minimum per kind of change:

- **Config, resources, translations, icons.** L1 + L3 + L4. The artifact gate is the whole proof here: the
  diff *is* the feature, so show it inside the built file.
- **Logic over an SDK, a store or a parser.** L1–L3 + a three-layer behavioural test: the pure function on
  edge cases → the glue against a fake → a contract test against the **real** SDK at the pinned tag. The third
  layer is what catches an SDK that disagrees with the fake.
- **UI component.** L1–L3 + an interactive host test (`flutter test` + `pumpWidget`, Robolectric + Compose,
  Vitest + DOM): mount, interact, assert on the **re-render**. First paint only is a snapshot of the bug.
- **Client↔service integration (calls, WebView bridge, updater).** L1–L6 + a headless run or a local stand
  that records the actual requests and bridge messages. "The build is green" says nothing about a handshake.

## 4. Definition of done: dev and QA

**dev proves deterministic correctness — L1–L7.** A failing test shown before the fix and passing after; the
round-trip path driven by production code; local suites and linters on the files touched; `apply-patches.sh`
and `check-markers.sh` run against the artifact that will ship; CI green. The handoff names the test that
covers the change and where it lives.

**QA verifies UX on the final artifact from CI** — the AppImage, `.deb`, APK or `dist`, never the source tree.
Layout, texts and localisation, smoothness, real system services (FCM push, installer, screen picker, camera
and microphone), cross-device. QA does not audit whether unit tests exist and does not write them for dev; a
test gap is a finding next to the verdict, not a licence to read the source instead. If the basic scenario is
broken, the card goes straight back to dev.

A verdict names what was observed, on which artifact, and what was not checkable. «Посмотрел, работает» is a
smoke check, not a verdict.

## 5. Checks do not slow the build

**5.1 Never on the critical path.** Tests and linters are their own job, a sibling of the artifact build, with
no `needs:` on it and nothing needing them. A serial "test, then build" inside one job lands in the time to a
verdict by construction, however fast the tests run. Three of ours, not hypothetical: Mobile's dart tests sat
serially before `Build APK` for 99 s (`Android APK` 25.3 → 15.9 min once they moved to a parallel job); then
the parallel job was added but the old step was left behind, so the tests ran twice and `Build APK` took 716 s
instead of 577 s; Element X's `setup-gradle` hashes the **job name** into its cache key, so two jobs made two
caches and the first run after a clear cost +6 min (`Assemble` 766 → 1133 s).

**5.2 A separate job is not free by itself:** it must **read** the shared cache, not create a key of its own,
or every prime pays the cold price. The point is to overlap with the build, not to duplicate its setup.

**5.3 Budgets, checked at acceptance.** A PR run answers in **≤ 5 minutes** from push to verdict. A tag run
takes no longer in wall-clock than the previous commit with the same set of steps; path filters do not apply to
tags, so the release lane stays complete. Measure the run (`created_at` → `updated_at`), never one step, and
put before/after in minutes plus both run links in the card.

**5.4 A slow run is a cause to find, not a suite to cut** — usually a cold cache or a whole-app compile, not
the tests themselves. The gate that enforces all this needs its negative control like any other, §1.2: this
document has one, `scripts/tests/standard-gate.sh` with `scripts/tests/standard-negative-control.sh` beside it.
