# FluffyChat with DeepFilterNet3

Plotina's Android build of [FluffyChat](https://github.com/krille-chan/fluffychat)
with DeepFilterNet3 (DFN3) denoising on outgoing call audio, on by default, no
user action.

**Status:** building in CI. `v2.11.3-plotina-fluffy.19` adds the in-app Plotina
logos, a reachable "Sign in" button and the `cc.plotina.fluffychat` OIDC scheme
that MAS requires; `.8` was the first release with FCM push and per-ABI splits;
earlier tags shipped the same denoiser as one fat APK.
The DFN3 path below was read from the pinned upstream, flutter_webrtc and
deep_filter sources and is covered by the APK-content check, but nobody has
listened to a call on a device yet.

## Upstream

| | |
|---|---|
| Tag | `v2.11.3` (`UPSTREAM_TAG`), commit `6fc4920` |
| Flutter | `3.47.8` (upstream `.fvmrc`) |
| Call stack | `livekit_client` 2.13.1, `flutter_webrtc` 1.6.2+hotfix.4 (both from `pubspec.lock`) |
| Patch | seven: `0001` pubspec (DFN), `0002` plotina.cc defaults, `0003` push gateway, `0004` ABI splits vs `abiFilters`, `0005` GlitchTip, `0006` noise level, `0007` application id `cc.plotina.fluffychat` (`patches/`) |

## What is in this directory

```
UPSTREAM_TAG                       v2.11.3
patches/0001-pubspec-add-plotina-dfn.patch
patches/0002-plotina-default-homeserver.patch
patches/0003-plotina-push-gateway.patch
patches/0004-split-per-abi-vs-abi-filters.patch
patches/0005-plotina-sentry.patch
patches/0006-plotina-noise-level.patch
patches/0007-plotina-application-id.patch
plotina_dfn/                       Flutter plugin (Android only)
  lib/plotina_dfn.dart             isAvailable / setEnabled / setAttenLim / frameLength / status
  android/…/PlotinaDfnPlugin.kt    attaches to flutter_webrtc, extracts the model
  android/…/DfnProcessor.kt        the audio-thread callback
  android/…/DfnNative.kt           JNI declarations, tolerates a missing .so
  rust/                            cdylib: JNI shim over libDF (`deep_filter`)
scripts/build-android.sh           same steps as CI, run locally
scripts/fetch-model.sh             downloads the model, SHA-256 pinned
patches/0012-plotina-intro-buttons.patch  intro "Sign in" always on-screen (see below)
patches/0013-plotina-oidc-scheme.patch    SSO scheme cc.plotina.fluffychat (MAS)
tests/intro_plotina_test.dart      Flutter widget regression test for 0012
```

The patch adds only this to `pubspec.yaml`:

```yaml
  plotina_dfn:
    path: ../plotina_dfn
```

Gradle picks the Rust library up from
`plotina_dfn/android/src/main/jniLibs/<abi>/libplotina_dfn.so`, so **no Gradle
file of FluffyChat is modified**.

## Intro screen: the "Sign in" button (patch 0012)

On a OnePlus 13 (CPH2649, Android 16) the welcome screen showed the logo,
subtitle and description but the login controls were not reachable. Cause, in
upstream `lib/pages/intro/intro_page.dart`: the body is
`LayoutBuilder -> SingleChildScrollView -> ConstrainedBox(minHeight: viewport)
-> IntrinsicHeight -> Column(..., Spacer, buttons, SizedBox(36))`. The
`Spacer` bottom-anchors the buttons to the *reported* layout viewport, and the
content height is forced to exactly that viewport, so the scroll view has zero
scroll range. When the visible window is shorter than the height Flutter lays
out for (Android 16 floating/resized windows, stale surface metrics), the
buttons land below the visible area and cannot be scrolled to. Two of the
three buttons ("Create account", "Login with Matrix-ID") are additionally
hidden by design here because patch 0002 presets `plotina.cc` as homeserver
(`hasPresetHomeserver: true`); only "Sign in" should ever be visible in Plotina
builds.

`0012-plotina-intro-buttons.patch` replaces the `const Spacer(),` with a fixed
`const SizedBox(height: 32),` so the buttons flow directly under the
description: their y-position no longer depends on the reported viewport
height, and when the content does exceed a small window the scroll extent is
content-driven and actually scrolls.

Verified with the pinned Flutter 3.47.8, not by eye:
`git apply --check` passes against a clean `v2.11.3` clone; all twelve-plus-one
patches apply in order; `dart analyze lib/pages/intro/` is clean; and
`tests/intro_plotina_test.dart` (run inside a fully patched upstream checkout
after `flutter pub get && flutter gen-l10n`) boots the real `FluffyChatApp`
through its router and asserts, at 1440x3168@4.0 and at the user's
1438x2411@4.0 window, that "Sign in" renders fully inside the viewport and
within 64 dp of the description. The gap assertion is the regression gate:
254 dp (Spacer, unpatched) vs 48 dp (patched). Note the user's screenshot is
either an area-crop or a window shot of 1438x2411 (full screen is 1440x3168):
the bottom ~757 px of the device are not in it, so the photo alone cannot show
the button; the fix makes the question moot by placing the buttons right under
the description text, which *is* inside that frame.

## Noise suppression level

The strength is a global setting, not per call:

- Settings → Chat → **Sound**: a slider from 0 to 100 dB, default **40**.
- **100** removes the attenuation limit (`DfTract` treats >= 100 as unlimited).
- **0** bypasses the denoiser: the channel sets `DfnProcessor.bypass`, no audio
  reaches the Rust handle, and the model is not loaded at startup.
- Any other value is pushed into the live `DfTract` through
  `DfTract::set_atten_lim` under the same mutex as `process()`, so a change
  takes effect on the next 10 ms frame and does not restart the call.
- The value is stored in `shared_preferences` as
  `chat.fluffy.noise_suppression_level` (`AppSettings.noiseSuppressionLevel` in
  `0006`). On Android the plugin reads the same key from
  `FlutterSharedPreferences` in `onAttachedToEngine`, before the model load is
  queued, because Dart's `main()` runs after that point.

```dart
await PlotinaDfn.setAttenLim(45); // dB, 0..100, no-op outside Android
```

## Push (FCM)

The APK carries Firebase Cloud Messaging, so notifications do not depend on the
ntfy app. The build does what upstream's Play build does:

1. The `GOOGLE_SERVICES_JSON` secret (base64 of `google-services.json` for the
   Firebase project `plotina-push`; it has clients for both
   `chat.fluffy.fluffychat` and `io.element.android.x`) is decoded into
   `android/app/google-services.json` **before** Gradle configures the project:
   `android/settings.gradle.kts` only declares the
   `com.google.gms.google-services` plugin when that file already exists.
2. `bash scripts/add-firebase-messaging.sh` (upstream's own script) adds
   `fcm_shared_isolate` — which brings `firebase_core` and
   `firebase-messaging` — and uncomments the FCM paths in
   `lib/utils/background_push.dart` and `FcmPushService.kt`.
3. `0003` points `pushNotificationsGatewayUrl` at our sygnal,
   `https://push.plotina.cc/_matrix/push/v1/notify`.

`0004` is not about push: upstream's `ndk { abiFilters … }` workaround in
`android/app/build.gradle.kts` makes AGP reject `--split-per-abi` ("Conflicting
configuration … cannot be present when splits abi filters are set"), which is why
tag `…-fluffy.7` produced no APK at all. The patch applies the workaround only to
fat builds.

Checked on the released APKs of `v2.11.3-plotina-fluffy.8`: 30
`com/google/firebase` strings in `classes*.dex` (the zip entry names stay at 0 —
R8 dexes the classes, so `unzip -l | grep com/google/firebase` proves nothing),
`plotina-push` plus `gcm_defaultSenderId`/`google_app_id` in `resources.arsc`, and
the gateway URL in `libapp.so` with the old `push.fluffychat.im` default gone. The
CI step fails the build if any of that is missing.

## Limitations

- Android only. iOS/macOS have an equivalent hook
  (`common/darwin/Classes/AudioProcessingAdapter.m`,
  `ExternalAudioProcessingDelegate`), which is a small Swift follow-up, not done
  here. Linux/Windows have no hook at all
  (flutter-webrtc#2016).
- Only WebRTC capture is denoised. Voice messages go through the `record`
  package (`MediaRecorder`/`AudioRecord`) and are unaffected.
- webrtc-sdk passes **channel 0 only**. Mono calls are fine; a stereo capture
  would denoise the left channel only.
- 32-bit x86 is not a Flutter target, so there is no x86 build. x86_64 is built
  and works, including on emulators; if the native library ever fails to load,
  `DfnNative.available` stays false and audio passes through untouched.
- The built-in NS/AGC still run before DFN3 (double processing). Cheap to tune
  later via `androidUseHardwareAudioProcessing` / APM config if it matters.
- 48 kHz only: any other rate is passed through rather than resampled.
- Registration is process-global and happens once. `PlotinaDfn.setEnabled(false)`
  and `PlotinaDfn.setAttenLim(0)` switch processing off; the level is global
  (Settings → Chat), not per call.
- DFN3 adds its algorithmic lookahead (~10 ms). Irrelevant next to network
  jitter, but it is not zero.

## Building

CI: `.github/workflows/build-fluffychat.yml`, triggered by a tag matching
`v*-plotina-fluffy.*` (for example `v2.11.3-plotina-fluffy.1`) or by
`workflow_dispatch`. The client-specific suffix matters: this repository also
builds Cinny, and the generic `v*-plotina.*` pattern used to start every client's
workflow at once.

The job clones upstream at the tag in `UPSTREAM_TAG`, applies the patches in
name order, builds the Rust library for arm64-v8a / armeabi-v7a / x86_64 with
`cargo ndk`, then runs `flutter build apk --split-per-abi`. Two of the three
splits are published: **`Plotina-FluffyChat.apk`** (arm64-v8a, what every recent
phone needs) and **`Plotina-FluffyChat-armv7.apk`** (older devices); x86_64 stays
with emulators.

### Signing

The key is a PKCS12 keystore with alias `plotina`, valid until 2126. Add these
under *Settings → Secrets and variables → Actions*:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 plotina-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `plotina` |
| `ANDROID_KEY_PASSWORD` | key password (falls back to the store password) |

With them the workflow writes `android/key.properties` and
`android/plotina-release.jks` into the upstream clone, which is exactly what
upstream's `build.gradle.kts` reads (it asks for `key.properties` in the Android
root and a `storeFile` relative to `android/app`).

**Without them the workflow builds a debug APK**, signed with the standard
Android debug key. It installs and is fine for testing the denoiser, but it
cannot update an installed Plotina build (nor an F-Droid/Play install): a
signature change always means uninstall first, which loses the local database
unless a backup exists. Note that upstream's release signing config points at a
`dummy.keystore` that is not in its repository, so a plain `--release` build
without the secrets would fail rather than produce an unsigned APK.

Locally: `fluffychat/scripts/build-android.sh` (needs Flutter 3.47.8, Rust with
Android targets, `cargo-ndk`, SDK+NDK, JDK 17).

## Crash reporting (GlitchTip)

Own integration (patch `0005`): `sentry_flutter 9.30.1` plus `lib/utils/plotina_sentry.dart`.
The DSN comes from the `SENTRY_DSN` repository variable; the release is `fluffy@<version>+<tag>`,
environment `production`; tracing, screenshots and PII are off.

CI uploads symbols (`--split-debug-info`, R8 mapping, native libraries) with `sentry-cli` when
`SENTRY_AUTH_TOKEN` is set and keeps them as the `Plotina-Mobile-symbols` artifact.
Smoke test: build with `--dart-define=PLOTINA_SENTRY_TEST_EVENT=true`.

## Licensing

Our code: AGPL-3.0-or-later, like upstream. DeepFilterNet (`deep_filter`
crate and the model) is MIT/Apache-2.0; the model is redistributed unchanged
from the upstream release. Its licence texts are in `plotina_dfn/assets/` and
are declared as Flutter assets, so they travel inside the APK.

The APK is built from `krille-chan/fluffychat` at `v2.11.3` plus `patches/` and
`plotina_dfn/`. The release notes and `../SOURCE.md` name the upstream tag and
the rebuild command; the same repository and tag are the corresponding source.
