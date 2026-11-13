# Plotina patches for Element X Android

Upstream: `element-hq/element-x-android` at the tag in `../pins.env` (`ELEMENT_X_TAG`).

**They are applied by one script, never by a list:**

```sh
element-x/scripts/apply-patches.sh <upstream-checkout> [markers-file]
```

`build-element-x.yml` and `validate-element-x.yml` both call it. It sorts `*.patch` with `LC_ALL=C`,
runs `git apply --check` and then `git apply` for each in that order, fails on a `.rej` or on a
shorter applied count than the directory holds, and writes the markers of the applied patches to a
file. The order is safe: each patch was verified against the tree the previous ones build, and no
patch depends on a later one, so the alphabetical order needs no manifest.

After the build, `element-x/scripts/check-markers.sh <apk> <markers-file>` looks for every marker in
the APK. A patch that is applied but absent from the artifact fails the build instead of shipping.

## Adding a patch

1. Number it after the last one (`NNNN-short-name.patch`), generated against the tree with all
   lower-numbered patches applied.
2. Put a header at the top of the file (before the first `diff --git`):

   ```
   # Plotina-Patch: <what it does, one line, continued on "#   " lines>
   # Plotina-Marker: <token>
   ```

   The token must be a string the built APK contains and **only your patch introduces** — usually a
   literal your own hunks add (a URL, an account-data event type, a log message, a string
   resource). It is checked in the APK, not in the source tree: R8 deletes the literals of code it
   removes, and the resource shrinker drops unreferenced strings. If the patch is build-level
   (signing, a Gradle flag, a locale filter) and ships no runtime string, have it write its marker
   into its own file under `app/src/main/assets/plotina-patches/` — assets are packaged verbatim.
3. Run `element-x/scripts/tests/run-tests.sh` and then apply the whole set to the pinned tag.

## The patches

| # | Patch | Marker |
| --- | --- | --- |
| 0002 | Release builds are signed with the Plotina key instead of upstream's debug key, which is what lets an update install over the previous APK. ABI splits are cut to `arm64-v8a` and `armeabi-v7a` with no universal APK (`-PplotinaSingleApk` builds one APK for all ABIs when that is wanted). | asset stamp `plotina-patch-0002-signing` |
| 0004 | The call WebView defaults to `https://call.plotina.cc/room` — our Element Call, where the noise suppression runs — instead of the bundle inside the APK. | `https://call.plotina.cc/room` |
| 0005 | `https://plotina.cc/app` is a verified app link of this APK (pathPrefix only, so the rest of the site stays in the browser). `mobile.element.io`'s assetlinks.json lists Element's certificates, not ours, so element.io invitation links can never reach this build. | asset stamp `plotina-patch-0005-app-link` |
| 0006 | The default account provider is `plotina.cc` instead of `matrix.org`, so sign-in opens on our homeserver without anyone typing the address. | asset stamp `plotina-patch-0006-account-provider` |
| 0007 | The Firebase pusher registers against `https://push.plotina.cc` instead of matrix.org's gateway, which would reject a token from our Firebase project. | `https://push.plotina.cc/_matrix/push/v1/notify` |
| 0008 | The Sentry release is `element-x@<version+tag>` (stamped as `io.sentry.release` in the manifest, from `PLOTINA_SENTRY_RELEASE`), and release builds report environment `production` instead of upstream's `RELEASE`. No init code: the app-side SDK is upstream's `services/analyticsproviders/sentry`, initialised by its own `SentryAnalyticsProvider`. | `element-x@` |
| 0009 | Application id `cc.plotina.x` and application name `Plotina X` instead of `io.element.android.x` / `Element X`. | asset stamp `plotina-patch-0009-application-id` |
| 0010 | The visible strings: `Plotina Call` instead of `Element Call` (foreground-service notification, incoming-call subtitle), the onboarding headline and the unsupported-call notice. | `Plotina Call does not support using Bluetooth audio devices` |
| 0011 | Keep only the two maintained UI locales (`en`, `ru`) in the APK. | asset stamp `plotina-patch-0011-locales` |
| 0012 | About shows only the open-source licence list, not upstream's element.io legal links. | asset stamp `plotina-patch-0012-about-minimal` |
| 0013 | No PostHog analytics and no Sentry reporting. | asset stamp `plotina-patch-0013-analytics-off` |
| 0014 | The in-app updater: an «Обновления» row at the root of Settings right above About, opening `PlotinaUpdatesActivity` («Проверить обновления» on top, the Stable/Dev channel section beneath), which fetches `https://plotina.cc/dl/update-x.json`, downloads the APK with `DownloadManager`, verifies sha256 and size, and hands it to the system `PackageInstaller`; `MainActivity` runs a silent once-a-day check. The same patch derives the versionCode from the release tag (`vYY.MM.p-plotina-x.N` → `(2000+YY)*100000 + MM*1000 + N`) and carries the dev channel (`-PplotinaDevBuild=M` grows only the `-dev.M` versionName and reads `update-x-dev.json` from the GitHub `dev-latest` release). | `https://plotina.cc/dl/update-x.json` |
| 0015 | Personal names for personal dialogues: the name belongs to the account, lives in the `cc.plotina.contact_names` account data event (the same contract Element Web and Mobile write), and is laid over `RoomInfo.name` in Kotlin for the room list, the open chat and the room details header. `m.room.name` and `m.room.member` are never written; DM only, a group keeps its name. See `../PERSONAL-NAMES.md`. | `Plotina: could not read the personal names of this account` |
| 0016 | Contact names for people everywhere a person is named: the room list row, the chat title, the room details header and the notification show the personal name of the person on the other side (heroes and the inviter included), not only the room's name. | `Plotina: could not read the personal names for a notification` |

`0001` and `0003` (the native call build) and `0003`-era numbering are gone: the native-call
experiment was removed from the tree and survives only in git history. Gaps in the numbering are
expected — they are not missing files.
