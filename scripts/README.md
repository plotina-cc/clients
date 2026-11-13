# Patch application and the artifact gate

Two scripts, used by every client that carries patches. Both are called from CI, never copied into
a workflow, so the path from `patches/` to a shipped artifact is one path:

```sh
scripts/apply-patches.sh <client-dir> <upstream-dir> [markers-file]
scripts/check-markers.sh  <artifact>   <markers-file>
```

`cinny`, `fluffychat` and `element-call` call them from their build workflows. `element-x` keeps its
own copies (`element-x/scripts/…`) as the reference implementation this one was generalized from;
they are the same contract and are folded in here the next time Element X changes.

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
