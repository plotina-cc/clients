# Element X for Android, with calls on Plotina's Element Call

Upstream [element-x-android](https://github.com/element-hq/element-x-android) at a pinned tag, with
one patch: Element X normally renders a call in a WebView against the Element Call bundle it ships
inside its own APK. This build points that WebView at **our** Element Call,
`https://call.plotina.cc/room`, so a call opens there by default — nothing to type in, no developer
setting to find.

That is the whole product: the app stays upstream Element X (same UI, same login, same E2EE), but the
call runs on our origin, which is where our noise suppression lives and where we control the
deployment. The bundled Element Call stays in the APK untouched, as the offline fallback.

Two more things are baked in, both one-liners or one secret: **push notifications** go through our own
gateway (`https://push.plotina.cc`) from the `gplay` flavour, which is the only upstream flavour that
carries the Firebase provider at all, and the sign-in screen is prefilled with `plotina.cc`.

**Status:** green in CI. `v26.10.1-plotina-x.4` built `assembleFdroidDebug` in 12m24s and the
workflow's own checks passed: the APK contains `assets/element-call/index.html` (the fallback) and the
string `https://call.plotina.cc/room` in `classes*.dex`. `https://call.plotina.cc/room` answers `200`
from Caddy. What is **not** verified is a call on a phone — see
[what to check on a device](#what-to-check-on-a-device).

Contents: [what is baked in](#what-is-baked-in) · [override](#overriding-it) ·
[install and signing](#installing-and-signing) · [building](#building) ·
[the native path, kept as a reserve](#the-native-path-kept-as-a-reserve) · [limitations](#limitations)

---

## What is baked in

| | |
| :-- | :-- |
| Call base URL | `https://call.plotina.cc/room` |
| Where | `features/call/impl/.../utils/DefaultCallWidgetProvider.kt`, `PLOTINA_CALL_WIDGET_BASE_URL` (patch `0004`, line 27 of the patched file) |
| Used at | the same file, `val baseUrl = customBaseUrl ?: PLOTINA_CALL_WIDGET_BASE_URL` (line 52) |
| Upstream default it replaces | `https://appassets.androidplatform.net/element-call/index.html` (still in the file, still in the APK) |

Push:

| | |
| :-- | :-- |
| Push gateway | `https://push.plotina.cc/_matrix/push/v1/notify` |
| Where | `libraries/pushproviders/firebase/.../FirebaseConfig.kt`, `PUSHER_HTTP_URL` (patch `0007`) |
| Upstream default it replaces | `https://matrix.org/_matrix/push/v1/notify` — Element's gateway, which resolves an FCM token against Element's own Firebase project and rejects a token issued to ours |
| Firebase project | `plotina-push`, from the `GOOGLE_SERVICES_JSON` secret, written into `app/src/gplay/res/values/firebase.xml` at build time |
| Flavour | `gplay`; `fdroid` has no Firebase dependency at all (`gplayImplementation(...)` in `app/build.gradle.kts`) |
| Pusher `app_id` | `im.vector.app.android` (upstream default, `BuildConfig.PUSHER_APP_ID`); sygnal keys its Firebase credentials on it |

Element X builds the final URL itself: `getWidget()` takes the base URL, asks the Rust SDK to append
the widget query (`widgetId`, `roomId`, `parentUrl`, `userId`, …) and loads the result in the WebView.
Only the base changes, so the call is still a widget call over the same driver; it just runs on our
origin instead of Element's asset loader.

## Crash and error reporting (Sentry → GlitchTip)

This uses **upstream's own Sentry integration** — `services/analyticsproviders/sentry`, with
`io.sentry:sentry-android:8.59.0`, initialised by its `SentryAnalyticsProvider`. There is no init
code of ours; the build only feeds it a DSN, a release name and an environment.

| | |
| :-- | :-- |
| DSN | GitHub **variable** `SENTRY_DSN` → `ELEMENT_ANDROID_SENTRY_DSN` at build time → `BuildConfig.SENTRY_DSN`, in the relay's project form: `https://<key>@sentry.plotina.cc/relay/<project-id>`. Sentry's SDK splits a DSN into a base and a project id — the last path segment is the project id — and posts to `<base>/api/<project-id>/envelope/`, so `…/relay/1` becomes `POST /relay/1/api/1/envelope/` |
| Release | `element-x@<version+tag>`, e.g. `element-x@26.10.1-plotina-x.14`: the git tag, stamped as `io.sentry.release` manifest meta-data from `PLOTINA_SENTRY_RELEASE` (patch `0008`) |
| Environment | `production` for release builds (`SentryConfig.ENV_RELEASE`, patch `0008`); upstream's `DEBUG`/`NIGHTLY` values are untouched |
| Native crashes | sentry-native ships inside `sentry-android` (the NDK integration is on by default); the AAR packages `libsentry*.so` per ABI |
| When it reports | only after the user opts into analytics — upstream's provider is initialised by `DefaultAnalyticsService` on consent, and `Sentry.capture*` is gated by the same flag |
| Rust SDK | `ELEMENT_SDK_SENTRY_DSN` is set to the same DSN: matrix-rust-sdk has its own Sentry client and reports Rust panics/errors; its events carry the SDK's release name (the app version), because that config has no release field |
| Bundled Element Call | `ELEMENT_CALL_SENTRY_DSN` is **unset**: the app passes that DSN to whichever call page it loads, our own `call.plotina.cc` included, and that deployment already reports under `element-call@<tag>` (the `sentry` block in `config.json` is the second-init trap). The embedded bundle is a fallback that only loads when our origin is unreachable under the default URL |

The workflow sets the release from the tag (`element-x@26.10.1-plotina-x.14`) and checks the APK
afterwards: the DSN host must be in `classes*.dex`, `io.sentry.release` must be in the merged
manifest, and `libsentry*.so` must be packaged. Without `SENTRY_DSN` the build still runs, but says
so loudly — that APK would never report anything.

Not wired yet:

- **Envelope delivery is blocked on the relay's path handling.** Caddy strips `/relay` and hands the
  relay `/1/api/1/envelope/`, while the relay only routes `/api/1/envelope/`, so the app's POST gets
  `404 {"error":"unknown path"}`. The relay (or Caddy's prefix) has to drop the project-id segment;
  until then the SDK initialises, builds the envelope and retries it, and nothing lands in GlitchTip.
- **Symbolication.** `sentry-cli upload` needs `/api/0/*` on the relay, which still answers `403`
  (only `/relay/*` is public). Until that opens, native frames and R8-renamed Java frames arrive
  unsymbolicated; the events themselves are unaffected.

## Overriding it

A user can still point the app somewhere else, and that is deliberately preserved:

1. **Settings → Advanced settings → Developer mode** (on).
2. Back to **Settings → Developer options** → **Custom Element Call base URL**.
3. Enter a base URL (`https://…`, scheme required) and confirm. Clearing the field returns the
   default, i.e. our URL.

The value lives in `AppPreferencesStore.getCustomElementCallBaseUrlFlow()`; `DefaultCallWidgetProvider`
prefers it whenever it is set. To get upstream behaviour back without a rebuild, enter
`https://appassets.androidplatform.net/element-call/index.html`.

## Installing and signing

The workflow builds what the secrets allow:

| Secrets present | Variant | Application id | Signed with |
| :-- | :-- | :-- | :-- |
| none | `assembleGplayDebug` | `io.element.android.x.debug` | the Android debug key |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | `assembleGplayRelease` | `io.element.android.x` | the plotina key |

The four signing secrets are configured, so what is published is a release build signed with the
Plotina key. Without them the workflow still builds, but a debug APK carries the `.debug` application
id and the debug key: it installs alongside a release build instead of over it, and the next release
build has to be installed from scratch. `GOOGLE_SERVICES_JSON` is deliberately not in that table —
it is not optional, and the build fails without it.

Sizes are the per-ABI splits of a release build: the arm64-v8a APK is ~136 MB and the armeabi-v7a one
~99 MB (measured on `v26.10.1-plotina-x.7`; the `gplay` variant adds a few MB of Firebase and Play
Services classes). The build produces exactly those two: patch `0002` narrows the ABI splits to
`arm64-v8a` and `armeabi-v7a` and turns the universal APK off, because packaging four splits plus a
400 MB universal APK ran the Gradle daemon out of heap on the CI runner.

Signing is one set of repository secrets away, no code change:

| Secret | What it is |
| :-- | :-- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 plotina.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `plotina` |
| `ANDROID_KEY_PASSWORD` | key password |

With all four set the same workflow builds and signs `assembleFdroidRelease` with that key. The key is
permanent: the first signed release defines it for the lifetime of the app, and losing it means every
user uninstalls and reinstalls.

## Building

CI only (`.github/workflows/build-element-x.yml`); nothing is built on golova.

- **Tags** `v*-plotina-x.*` (e.g. `v26.10.1-plotina-x.1`) and **workflow_dispatch** build. Tags also
  publish a GitHub release.
- Artifact and release asset always have the same name: **`Plotina-ElementX.apk`**.
- Jobs: `patches` (clone the pinned tag, `git apply --check` every patch — two minutes, catches
  upstream drift before the expensive job) then `build` (JDK 21, SDK 37 / build-tools 37.0.0,
  `assembleGplayRelease`, publish).
- Before Gradle runs, `GOOGLE_SERVICES_JSON` is decoded to `app/google-services.json` and
  `element-x/scripts/firebase-resources.py` writes `app/src/gplay/res/{values/firebase.xml,
  raw/keep.xml}` from it. No Google Services Gradle plugin — see [push](#what-is-baked-in): upstream
  does not use it either, and its Firebase values are hand-maintained resources.
- No Rust, no cargo-ndk, no NDK, no `publishToMavenLocal`: the native path below is not in this
  build's dependency graph at all.
- The build fails rather than shipping a wrong APK if `assets/element-call/index.html` is missing
  (the fallback must stay), if `https://call.plotina.cc/room` is not in `classes*.dex`, if the APK
  has no `com/google/firebase` entries, if `project_id` is not `plotina-push`, if
  `https://push.plotina.cc/_matrix/push/v1/notify` is not in the dex, or — when `SENTRY_DSN` is set
  — if the DSN is missing from the dex or `io.sentry.release` is not the tag in the manifest.
- Pull requests touching `element-x/**` run the patch check only.

Locally, by hand:

```sh
git clone --depth 1 -b v26.10.1 https://github.com/element-hq/element-x-android /tmp/ex
cd /tmp/ex
git apply /path/to/clients/element-x/patches/0002-element-x-android-plotina-signing.patch \
          /path/to/clients/element-x/patches/0004-element-x-android-plotina-call-url.patch \
          /path/to/clients/element-x/patches/0005-element-x-android-plotina-app-link.patch \
          /path/to/clients/element-x/patches/0006-element-x-android-plotina-account-provider.patch \
          /path/to/clients/element-x/patches/0007-element-x-android-plotina-push-gateway.patch \
          /path/to/clients/element-x/patches/0008-element-x-android-plotina-sentry.patch
base64 -d /path/to/google-services.json.b64 > app/google-services.json
python3 /path/to/clients/element-x/scripts/firebase-resources.py \
        app/google-services.json app/src/gplay/res
# Sentry: the DSN goes in at configuration time, the release name is read from the manifest.
export ELEMENT_ANDROID_SENTRY_DSN="$(gh variable get SENTRY_DSN -R plotina-cc/clients)"
export PLOTINA_SENTRY_RELEASE="element-x@26.10.1-plotina-x.14"
./gradlew -PplotinaSingleApk assembleGplayDebug
```

`0002` is only needed for a signed release build; `-PplotinaSingleApk` is what turns the four ABI
splits into one APK, and is not required for a debug build either. The Firebase step is what makes
the `gplay` build able to talk to our project: skip it and the APK builds, installs, and never gets
a token.

## The native call path

An earlier experiment ran DeepFilterNet3 inside a native-call build (a Rust JNI shim plus
`FeatureFlags.NativeCall`). It was never enabled in CI: at `v26.10.1` native calls are unfinished,
and the WebView path reaches noise suppression through our own Element Call deployment with one
constant and no native code. The files were removed from the tree; git history still has them if
the native stack ever becomes worth the Rust cross-compilation, the NDK and the extra ~8 MB.

## Limitations

- **Android only.** No iOS: different codebase, different RTC stack, macOS runner and an Apple
  developer account — none of that exists here.
- **The call depends on `call.plotina.cc`.** If the host is down the call does not start; there is no
  automatic fallback to the bundled Element Call (the user can select it in developer settings as
  above). This is the trade for owning the call origin.
- **WebView call, not a native call.** Same as upstream Element X today: no native call UI, PiP works
  through the WebView activity only.
- **Application id** is upstream's (`io.element.android.x`, `.debug` for the debug build). It does not
  install over Element X from Google Play — same id, different key — uninstall that first.
- **No instrumented test** for "the call opened on our URL". The CI check proves the constant is in
  the APK and the asset fallback is present; only a device proves the call itself.

## What to check on a device

1. Start a call in a room. The WebView should show `call.plotina.cc` — visible in the URL of the
   widget, or `adb logcat | grep -i elementcall` for the activity's console messages.
2. Microphone permission prompt appears, and the far end hears audio.
3. A second participant joins: E2EE key exchange, then audio, as with any Element Call.
4. If the deployment has the noise layer in front of it, the far end should hear the denoised
   microphone — compare against a call placed in Element Web on the same server.
5. Hang up, call again: the WebView must reload our URL, not the bundled one.
6. Settings → Developer options → Custom Element Call base URL: setting it to the `appassets` URL must
   bring back the bundled Element Call (proves the override still works).

Crash reporting, on a device (the APK has to be built with `SENTRY_DSN` set):

1. Opt into analytics (the FTUE screen, or Settings → Privacy → Analytics). Nothing is sent before
   that — upstream gates the provider on the same flag.
2. `adb logcat -s Sentry` should say `Initializing SDK with DSN: 'https://…@sentry.plotina.cc/relay'`
   and then, on a send, no `Envelope submission failed`.
3. Crash the app (`adb shell am crash io.element.android.x`, or kill it with `SIGSEGV` from a root
   shell) and reopen it. GlitchTip → project → Issues should show the crash under release
   `element-x@<tag>` and environment `production`; the release also shows up under Releases even
   without a crash, because session envelopes carry the same name.
4. A native crash is captured by sentry-native, not by the Java handler: its stack trace stays
   unsymbolicated until `/api/0` accepts `sentry-cli upload`, but the event itself must arrive.
