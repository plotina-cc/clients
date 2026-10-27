# Element X for Android, with calls on Plotina's Element Call

Upstream [element-x-android](https://github.com/element-hq/element-x-android) at a pinned tag, with
one patch: Element X normally renders a call in a WebView against the Element Call bundle it ships
inside its own APK. This build points that WebView at **our** Element Call,
`https://call.plotina.cc/room`, so a call opens there by default — nothing to type in, no developer
setting to find.

That is the whole product: the app stays upstream Element X (same UI, same login, same E2EE), but the
call runs on our origin, which is where our noise suppression lives and where we control the
deployment. The bundled Element Call stays in the APK untouched, as the offline fallback.

**Status:** the URL patch, the workflow and the APK checks are in place; the first CI build is the
open question, not the design. `https://call.plotina.cc/room` is deployed separately (Caddy on the
edge + the element-call artifact) and may not answer yet — that does not stop the APK from building,
but an APK should not be handed out until it does.

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

Element X builds the final URL itself: `getWidget()` takes the base URL, asks the Rust SDK to append
the widget query (`widgetId`, `roomId`, `parentUrl`, `userId`, …) and loads the result in the WebView.
Only the base changes, so the call is still a widget call over the same driver; it just runs on our
origin instead of Element's asset loader.

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
| none | `assembleFdroidDebug` | `io.element.android.x.debug` | the Android debug key |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | `assembleFdroidRelease` | `io.element.android.x` | the plotina key |

**No secrets are configured yet, so today's APK is a debug build.** Consequences worth stating
plainly: it is signed with the debug key and has the `.debug` application id, so it installs
alongside an existing Element X rather than over it — and a later release-signed build (same id, our
key) has to be installed **from scratch**, after uninstalling. It is fine for testing the call path;
it is not a build to hand to a community and then update in place.

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
- Jobs: `patches` (clone the pinned tag, `git apply --check` both patches — two minutes, catches
  upstream drift before the expensive job) then `build` (JDK 21, SDK 37 / build-tools 37.0.0,
  `assembleFdroidDebug`, publish).
- No Rust, no cargo-ndk, no NDK, no `publishToMavenLocal`: the native path below is not in this
  build's dependency graph at all.
- The build fails rather than shipping a wrong APK if `assets/element-call/index.html` is missing
  (the fallback must stay) or if `https://call.plotina.cc/room` is not in `classes*.dex`.
- Pull requests touching `element-x/**` run the patch check only.

Locally, by hand:

```sh
git clone --depth 1 -b v26.10.1 https://github.com/element-hq/element-x-android /tmp/ex
cd /tmp/ex
git apply /path/to/clients/element-x/patches/0002-element-x-android-plotina-signing.patch \
          /path/to/clients/element-x/patches/0004-element-x-android-plotina-call-url.patch
./gradlew -PplotinaSingleApk assembleFdroidDebug
```

`0002` is only needed for a signed release build; `-PplotinaSingleApk` is what turns the four ABI
splits into one APK, and is not required for a debug build either.

## The native path, kept as a reserve

`native/plotina-dfn/` (a Rust JNI shim around DeepFilterNet3), `patches/0001` (element-call-android:
denoise each 10 ms capture frame before it is published) and `patches/0003`
(`FeatureFlags.NativeCall` default `true`) are still in this repository and still documented in git
history. **They are not applied by the workflow and not part of this APK.** Reasons, in order:

- At `v26.10.1` native calls are `isFinished = false`, `FeatureFlags.NativeCall` defaults to false,
  and the stack is an `0.1.0-rc.8` library. Turning it on to get a denoiser was always the heavier
  trade.
- The WebView path reaches noise suppression through *our* deployment instead, with one constant and
  no native code.
- The native path costs Rust cross-compilation, an NDK, an ~8 MB model in the APK, a patched
  element-call-android published to mavenLocal, and arm64-v8a only.

To revive it: put back the cargo-ndk + `publishToMavenLocal` steps at the parent commit of the
`element-x` branch, apply `0001`/`0003`, and build with `-PelementCallLocalVersion`. If both paths are
ever wanted at once, note that `0003` sends calls to the native stack and `0004` is then dead code.

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
