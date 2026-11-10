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
cd /tmp/ex
for p in /path/to/clients/element-x/patches/*.patch; do git apply "$p"; done
base64 -d /path/to/google-services.json.b64 > app/google-services.json
python3 /path/to/clients/element-x/scripts/firebase-resources.py \
        app/google-services.json app/src/gplay/res
export ELEMENT_ANDROID_SENTRY_DSN="$(gh variable get SENTRY_DSN -R plotina-cc/clients)"
export PLOTINA_SENTRY_RELEASE="element-x@26.10.1-plotina-x.14"
./gradlew -PplotinaSingleApk assembleGplayDebug
```

## Updating in-app (patch 0014)

There is no Play channel here, so Plotina X ships its own updater: platform APIs only —
`HttpURLConnection` for the manifest, `DownloadManager` for the APK, `PackageInstaller` for the
install, no third-party update SDK.

- **«Проверить обновления» lives at the root of Settings, right above «О приложении»**, and opens
  the full-screen updater page; a **silent check runs at most once a day** when the app starts and
  opens that page only when the manifest really is newer. The page mirrors the Plotina Mobile
  updater route: AppBar «Проверка обновлений», one centred 480 dp column, a stage per state
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

### versionCode

A release tag `vYY.MM.p-plotina-x.N` maps to the base versionCode

    (2000 + YY) * 100_000 + MM * 1_000 + N      # v26.10.1-plotina-x.25 -> 202610025

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
