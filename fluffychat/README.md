# FluffyChat with DeepFilterNet3

Plotina's Android build of [FluffyChat](https://github.com/krille-chan/fluffychat)
with DeepFilterNet3 (DFN3) denoising on outgoing call audio, on by default, no
user action.

**Status:** building in CI. `v2.11.3-plotina-fluffy.8` is the first release with
FCM push and per-ABI splits; earlier tags shipped the same denoiser as one fat APK.
The DFN3 path below was read from the pinned upstream, flutter_webrtc and
deep_filter sources and is covered by the APK-content check, but nobody has
listened to a call on a device yet.

## Upstream

| | |
|---|---|
| Tag | `v2.11.3` (`UPSTREAM_TAG`), commit `6fc4920` |
| Flutter | `3.47.8` (upstream `.fvmrc`) |
| Call stack | `livekit_client` 2.13.1, `flutter_webrtc` 1.6.2+hotfix.4 (both from `pubspec.lock`) |
| Patch | four: `0001` pubspec (DFN), `0002` plotina.cc defaults, `0003` push gateway, `0004` ABI splits vs `abiFilters` (`patches/`) |

## What is in this directory

```
UPSTREAM_TAG                       v2.11.3
patches/0001-pubspec-add-plotina-dfn.patch
patches/0002-plotina-default-homeserver.patch
patches/0003-plotina-push-gateway.patch
patches/0004-split-per-abi-vs-abi-filters.patch
patches/0005-plotina-sentry.patch
plotina_dfn/                       Flutter plugin (Android only)
  lib/plotina_dfn.dart             isAvailable / setEnabled / frameLength / status
  android/…/PlotinaDfnPlugin.kt    attaches to flutter_webrtc, extracts the model
  android/…/DfnProcessor.kt        the audio-thread callback
  android/…/DfnNative.kt           JNI declarations, tolerates a missing .so
  rust/                            cdylib: JNI shim over libDF (`deep_filter`)
scripts/build-android.sh           same steps as CI, run locally
scripts/fetch-model.sh             downloads the model, SHA-256 pinned
```

The patch adds only this to `pubspec.yaml`:

```yaml
  plotina_dfn:
    path: ../plotina_dfn
```

Gradle picks the Rust library up from
`plotina_dfn/android/src/main/jniLibs/<abi>/libplotina_dfn.so`, so **no Gradle
file of FluffyChat is modified**.

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
- Registration is process-global and happens once; there is no per-call toggle
  beyond `PlotinaDfn.setEnabled(false)`.
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
`SENTRY_AUTH_TOKEN` is set and keeps them as the `Plotina-FluffyChat-symbols` artifact.
Smoke test: build with `--dart-define=PLOTINA_SENTRY_TEST_EVENT=true`.

## Licensing

Our code: AGPL-3.0-or-later, like upstream. DeepFilterNet (`deep_filter`
crate and the model) is MIT/Apache-2.0; the model is redistributed unchanged
from the upstream release.
