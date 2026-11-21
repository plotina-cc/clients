# Patch application, the artifact gate, and the lint gate

Three entry points, used by every client that carries patches. All are called from CI, never copied
into a workflow, so each path is one path:

```sh
scripts/apply-patches.sh  <client-dir> <upstream-dir> [markers-file]
scripts/check-markers.sh  <artifact>   <markers-file>
scripts/lint-patches.sh   --stack shell|dart|ts|kotlin [--tree CLIENT=DIR ...]
```

`cinny`, `fluffychat` and `element-call` call the first two from their build workflows. `element-x`
keeps its own copies (`element-x/scripts/…`) as the reference implementation this one was generalized
from; they are the same contract and are folded in here the next time Element X changes.

## What `lint-patches.sh` guarantees

- Lints the lines **our patches add**, not the files they land in: `scripts/lint/findings.py` reads
  the diff the applied patches produced and splits each linter's findings by line. A finding on an
  untouched line of a patched file is printed and counted, never failed.
- A missing linter is exit 2 with the tool named. `command -v shellcheck || exit 0` is how a gate
  becomes decoration.
- Tolerated findings live in `scripts/lint/baseline.txt`, one `<stack>|<path>:<line> <rule>` per
  line with the reason above it. A finding that is not in it fails the run, and so does an entry
  that stopped occurring, so the list can only shrink. Nothing is silenced by switching a rule off.
- Rules per stack, and why each was chosen or excluded, are in `scripts/lint/README.md`.

## What `apply-patches.sh` guarantees

- Applies **every** `<client-dir>/patches/*.patch`, in `LC_ALL=C` byte order. Nothing else is
  applied: a `.patch` that happens to sit inside the upstream checkout is ignored.
- `git apply --check` before `git apply`, per patch, against the tree the previous patches built.
- Fails on a `.rej` left in the tree, on `applied != files in the directory`, and on a
  `<client-dir>` with no `patches/` directory at all.
- Fails on a patch with no `# Plotina-Marker:` header, and on a marker that no added line of that
  patch contains — a marker satisfied by a context line would prove nothing.
- Writes `<patch-name><TAB><token>` for each applied patch to the markers file.

## What `check-markers.sh` guarantees

- Reads the markers file the apply step produced, so it checks what was really applied, never a
  list written by hand next to it.
- Accepts the artifact shapes the clients produce: a directory (cinny's built web dist,
  element-call's unpacked bundle), a zip (an APK), a tar.gz, or a plain file (`app.asar`,
  an AppImage).
- Streams the artifact through `strings` twice, UTF-8 and UTF-16LE, because a marker can live in a
  JS chunk, a Dart AOT snapshot, the dex string pool, `resources.arsc` or a compiled manifest.
- Fails, naming the patch and the missing token, when a marker is absent — and fails when the
  marker list is empty or the artifact cannot be read, because a gate that checks nothing is not
  green.

## The standard's own gate

`scripts/tests/standard-gate.sh` checks `CONTRIBUTING.md` itself: all five sections present, each rule stated
by the phrase that carries it, the section-5 budgets in numbers ("≤ 5 minutes", wall-clock measured on the run),
every script the document names present and executable, no internal path or hostname in this public repository,
and the three-minute reading budget. `scripts/tests/standard-negative-control.sh` mutates the document one rule
at a time and requires the gate to reject each mutation; `run-tests.sh` runs both, so the build that already
runs the suites also refuses a standard with a section quietly deleted.

## Adding a patch

1. Number it after the last one and generate it against the tree with all lower-numbered patches
   applied.
2. Put the header at the top of the file, before the first `diff --git`:

   ```
   # Plotina-Patch: <what it does, one line>
   # Plotina-Marker: <token>
   ```

   The token must be a string the **artifact** contains and that your patch introduces: a UI string,
   a URL, an account-data event type, a localStorage key. Not an identifier — the minifier renames
   those. Not a comment — comments do not ship.
3. If the patch is build-level (a Gradle flag, a pubspec dependency, a lint fix) and adds no runtime
   string of its own, have the patch write its marker into a file the artifact carries verbatim —
   `android/app/src/main/assets/plotina-patches/<name>.txt` for a Flutter APK,
   `public/res/plotina-patches/<name>.txt` for a cinny bundle, `public/plotina-patches/<name>.txt`
   for element-call — and add `# Plotina-Note:` saying so, as the existing ones do.
4. Run `scripts/tests/run-tests.sh`, then apply the whole set to the pinned upstream:
   `scripts/apply-patches.sh <client> <upstream-checkout>`.
5. The gate runs after the build in CI. If it names your marker, the patch reached the source but
   not the artifact — fix the patch, do not remove the marker.
