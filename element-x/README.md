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
both build; a tag also publishes a release with `Plotina-ElementX.apk`.

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

## Limitations

- Android only.
- A call needs `call.plotina.cc` to be reachable; the bundled fallback is only used if the user
  selects it in developer settings.
- Upstream's application id (`io.element.android.x`): uninstall Element X from Google Play before
  installing ours.
