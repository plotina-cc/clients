# Element X for Android

Upstream [element-x-android](https://github.com/element-hq/element-x-android) at tag `v26.10.1`,
patched so calls run on our own Element Call instead of the bundle inside the APK.

## What is baked in

- **Calls** open at `https://call.plotina.cc/room` — our deployment, where the noise suppression
  runs. The bundled Element Call stays in the APK as a fallback.
- **Push** goes through `https://push.plotina.cc/_matrix/push/v1/notify` (Firebase project
  `plotina-push`), not Element's gateway.
- **Sign-in** is prefilled with `plotina.cc`.
- **Crash reports** go to GlitchTip under release `element-x@<tag>`, environment `production`.
- **Personal names for DMs** are per account and kept in account data, so only their owner sees them
  and the other side keeps the room's name. See `PERSONAL-NAMES.md`.

## Source

The APK is built from `element-hq/element-x-android` at `v26.10.1` plus the
patches in `element-x/patches/`. The upstream tag, the patch order and the
`./gradlew` command are in `../SOURCE.md`; the release notes repeat the offer.
Upstream is AGPL-3.0-or-later; the patch layer here is AGPL-3.0.

## Installing and signing

Release builds are signed with the Plotina key. Repository secrets, all four required:

- `ANDROID_KEYSTORE_BASE64` — `base64 -w0 plotina.jks`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS` — `plotina`
- `ANDROID_KEY_PASSWORD`

`GOOGLE_SERVICES_JSON` is also required: it carries the `plotina-push` Firebase config. Without the
signing secrets the workflow still builds a debug APK (`io.element.android.x.debug`), which installs
alongside a release build rather than over it.

## Building

CI only (`.github/workflows/build-element-x.yml`). Tags `v*-plotina-x.*` and `workflow_dispatch`
both build; a tag also publishes a release with `Plotina-X*.apk`.

Locally:

```sh
git clone --depth 1 -b v26.10.1 https://github.com/element-hq/element-x-android /tmp/ex
element-x/scripts/apply-patches.sh /tmp/ex                     # all of patches/, in order
base64 -d /path/to/google-services.json.b64 > /tmp/ex/app/google-services.json
python3 element-x/scripts/firebase-resources.py \
        /tmp/ex/app/google-services.json /tmp/ex/app/src/gplay/res
cd /tmp/ex
export ELEMENT_ANDROID_SENTRY_DSN="$(gh variable get SENTRY_DSN -R plotina-cc/clients)"
export PLOTINA_SENTRY_RELEASE="element-x@26.10.1-plotina-x.14"
./gradlew -PplotinaSingleApk assembleGplayDebug
```

Do not apply the patches by hand: the script is the single entry point CI uses, it checks every
patch against the tree the previous ones built, and it writes the marker file that
`element-x/scripts/check-markers.sh <apk> <markers-file>` uses to prove the APK really carries them.
What each patch does is in `patches/README.md`.

Add `-PplotinaBuildNumber=30 -PplotinaDevBuild=1` to reproduce a dev-channel build of the
`v26.10.1-plotina-x.30-dev.1` shape (same versionCode as stable .30, versionName `26.10.1-dev.1`).

## Updating in-app (patch 0014)

There is no Play channel here, so Plotina X ships its own updater: platform APIs only —
`HttpURLConnection` for the manifest, `DownloadManager` for the APK, `PackageInstaller` for the
install, no third-party update SDK.

- **«Обновления» lives at the root of Settings, right above «О приложении»**, as one row over one
  page (mirroring Plotina Mobile's Updates tab): **«Проверить обновления» is the primary action on
  top** and it opens the full-screen updater page; **the update channel is selected below it**. A
  **silent check runs at most once a day** when the app starts and opens that updater page only
  when the manifest really is newer. The updater page mirrors the Plotina Mobile updater route:
  AppBar «Проверка обновлений», one centred 480 dp column, a stage per state
  (checking / available / up to date / permission / downloading / error + retry), all colours from
  the app theme.
- Manifest: `https://plotina.cc/dl/update-x.json` with exactly
  `{"client":"x","package":"cc.plotina.x","versionName":"26.10.1","versionCode":2026100252,
  "apkUrl":"https://plotina.cc/dl/Plotina-X.apk","sha256":"<hex>","size":<bytes>,
  "notes":"<short ru text>"}`. `build-element-x.yml` writes it from the built APK and attaches it
  to the release; `scripts/publish-clients.sh` copies it and `Plotina-X.apk` to the edge host
  under those stable names. The updater refuses a manifest whose `client`, `package`, `apkUrl`
  scheme, `sha256` shape or numbers do not check out, and discards a download whose sha256 or
  size mismatch before the installer ever sees it.
- Before the hand-off, the page asks for the **"install unknown apps"** permission through
  `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` if the system has not been told Plotina X may
  install apps.

### The dev update channel (opt-in)

- **The «Обновления» page selects the channel** in its lower section, beneath «Проверить
  обновления», with two radios: **Стабильный** (default, the edge host feed above) and **Dev**.
  (It used to be its own Settings row and Activity; consolidating them into the one page made the
  updater match Mobile's Updates tab.) The choice persists in the app's `plotina-updater` SharedPreferences
  and decides which feed both the manual check and the daily silent check read. Dev states in
  warning text that dev builds ride ahead of the newest stable and may break, and that switching
  back keeps the data.
- **The dev feed lives on GitHub, not on the edge host:**
  `https://github.com/plotina-cc/clients/releases/download/dev-latest/update-x-dev.json`. The
  `dev-latest` release is a moving target: its two assets (`update-x-dev.json`, `Plotina-X.apk`)
  are overwritten by hand — `gh release upload --clobber dev-latest Plotina-X.apk update-x-dev.json`
  — when someone decides a dev build should go out. Nothing automatic publishes it, and the tag is
  created once by hand.
- The dev manifest carries the **same `versionCode` as the stable it is based on** plus
  `"devBuild": M`. Comparison rules (unit-tested in `PlotinaUpdateTest`): a greater base code is
  always offered; an equal base only moves forward when the manifest's `devBuild` is greater than
  the installed one, and the installed dev number is read from the versionName suffix `-dev.M`.
  A stable manifest (no `devBuild`) therefore never bumps a same-code dev install.
- **Passive stable return**: switch back to Стабильный while a dev build runs, and as long as no
  published stable outranks it, the updater page says *«Пока dev-сборка, ждём стабильный релиз
  для перехода»* instead of "up to date". When the next stable (greater base) appears, it arrives
  through the ordinary update flow — same package id, same signing key, data preserved.
- AOSP permits replacing a package with an **equal versionCode**: `PackageManager.checkDowngrade`
  rejects only *lower* codes. That is what the dev-over-stable install relies on; some OEM skins
  are stricter, so real-device cross-grade testing remains manual.

Dev builds must be based on the **latest published stable revision, never an unreleased future
one**: CI refuses a `…-dev.M` tag whose stable tag with the same build number is not published
(see "Work out the versionCode" in `build-element-x.yml`).

### versionCode

A release tag `vYY.MM.p-plotina-x.N` maps to the base versionCode

    (2000 + YY) * 100_000 + MM * 1_000 + N      # v26.10.1-plotina-x.25 -> 202610025

A dev-channel tag `vYY.MM.p-plotina-x.N-dev.M` compiles the **same base** — the stable it is
based on — and only the versionName grows: `26.10.1-dev.M`. CI passes `N` as
`-PplotinaBuildNumber` and `M` as `-PplotinaDevBuild`, refuses the dev build outright unless the
stable tag with the same `N` is published, and writes `devBuild: M` into `update-x-dev.json`.
Example: stable `v26.10.1-plotina-x.30` (arm64 `2026100302`) and dev `v26.10.1-plotina-x.30-dev.1`
ship the same versionCode; the next stable `.31` (`2026100312`) is a normal upgrade that returns
dev users to the stable channel.

CI derives `N` from the tag and passes it as `-PplotinaBuildNumber` (see "Work out the
versionCode" in `build-element-x.yml` and the `defaultConfig` block patch 0014 adds to
`app/build.gradle.kts`). `update-x.json` carries the packaged versionCode of the **arm64** APK,
which CI reads back with `aapt` - the base with upstream's ABI digit appended (`base * 10 +
abiCode`; arm64-v8a is 2, armeabi-v7a 1). `PlotinaUpdate.baseCodeOf` strips that digit from the
manifest number *and* the installed number before comparing, so arm64 and armv7 installs agree
and an update to the newest build is never offered again on the same build. Every base
under this scheme is greater than the base of the pre-updater releases (upstream's `20261001`),
which is why the `(2000 + YY)` prefix stays: `Plotina-X.apk` always upgrades an installed
Plotina X. Locally, add `-PplotinaBuildNumber=N` or leave it out for upstream's own value.

### Testing the updater page against a local manifest

    python3 -m http.server 8000   # serving an update-x.json (+ the APK it names)
    adb shell am start -n cc.plotina.x.debug/io.element.android.x.updater.PlotinaUpdateActivity \
        --es plotina_manifest_url http://10.0.2.2:8000/update-x.json

`package: cc.plotina.x` in the manifest is accepted by the debug id `cc.plotina.x.debug`
(prefix match), so one manifest file serves both.

## Limitations

- Android only.
- A call needs `call.plotina.cc` to be reachable; the bundled fallback is only used if the user
  selects it in developer settings.
- Upstream's application id (`io.element.android.x`): uninstall Element X from Google Play before
  installing ours.
