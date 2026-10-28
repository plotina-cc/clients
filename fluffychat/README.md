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

## How call audio works in this version

All of this was read from the pinned sources, not from memory.

- Calls are MatrixRTC through **`livekit_client`**, not raw `flutter_webrtc`:
  `lib/pages/call/call_view_model.dart` builds `lk.Room` with
  `defaultAudioCaptureOptions: AudioCaptureOptions(echoCancellation: true,
  noiseSuppression: true, autoGainControl: true, highPassFilter: true)`.
  **WebRTC's built-in suppressor is therefore already requested**, so "just turn
  on the noise suppression flag" buys nothing — that is the classic spectral
  suppressor every Matrix client already has.
- `livekit_client` creates the mic track through flutter_webrtc:
  `LocalTrack.createStream` → `getUserMedia` → `GetUserMediaImpl.getUserAudio` →
  `PeerConnectionFactory.createAudioSource(constraints)`.
- On Android the device module is `JavaAudioDeviceModule`
  (`MethodCallHandlerImpl.initialize`, which also calls
  `setNoiseSuppressorEnabled(true)` — the *platform* suppressor).
- flutter_webrtc (`1.6.2+hotfix.4`, the version `pubspec.lock` resolves) exposes a public in-band hook:
  `FlutterWebRTCPlugin.sharedSingleton.audioProcessingController.capturePostProcessing`
  (`AudioProcessingAdapter`), installed via
  `PeerConnectionFactory.Builder.setAudioProcessingFactory(new ExternalAudioProcessingFactory())`.
  webrtc-sdk's `sdk/android/src/jni/pc/external_audio_processor.cc` calls it from
  `CustomProcessing::Process(AudioBuffer*)`, *after* APM and *before* the encoder.
- That hook is not a fork: LiveKit's own
  [`flutter-filter-plugin-example`](https://github.com/livekit-examples/flutter-filter-plugin-example)
  registers its filter with exactly `capturePostProcessing.addProcessor(...)`.

### The data contract (verified in webrtc-sdk `m150_release`)

```cpp
size_t num_frames = audio->num_frames();          // 480
size_t num_bands  = audio->num_bands();           // 3
external_processor_->Process(num_bands, num_frames, kNsFrameSize * num_bands,
                             audio->channels()[0]);
```

and the JNI side wraps that pointer as `NewDirectByteBuffer(env, buffer, buffer_size * sizeof(float))`.

So: **float32, deinterleaved, channel 0 only, 48 kHz, 480 samples per 10 ms
call**. `numFrames` = 480, `numBands` = 3. That is exactly DFN3's native rate and
hop, so the native side needs no resampling.

## Options considered

| | Effect | Maintenance |
|---|---|---|
| (a) WebRTC APM flags | none — already enabled upstream, classic NS | none |
| (b) DFN3 inside the WebRTC capture chain via `capturePostProcessing` | full DFN3, in band, before encoding | one 4-line patch + a self-contained plugin; no fork |
| (c) DSP outside WebRTC | needs a virtual mic or a custom ADM; loses AEC or requires forking webrtc-sdk | high |

**(b) chosen.** (c) is rejected because Android has no loopback device a normal
app can register, and replacing the ADM means forking webrtc-sdk — the thing we
are trying to avoid. (a) is a no-op here.

A ready-made alternative to building the crate exists:
[`io.github.kaleyravideo:android-deepfilternet`](https://github.com/KaleyraVideo/AndroidDeepFilterNet)
(Apache-2.0, Maven Central, 0.0.8) — a JNI wrapper over libDF, 48 kHz mono
**PCM16**, model in `res/raw` (7.98 MB), `libdf.so` 13.5 MB for arm64, 8 MB for
armeabi-v7a. It is a single-vendor project on a different sample format, so we
keep our own crate (model pin identical to the web clients, float32 in place, our
own ABI set). If the Rust toolchain in CI ever becomes a burden, swapping to that
AAR only touches the Kotlin glue.

## What is in this directory

```
UPSTREAM_TAG                       v2.11.3
patches/0001-pubspec-add-plotina-dfn.patch
patches/0002-plotina-default-homeserver.patch
patches/0003-plotina-push-gateway.patch
patches/0004-split-per-abi-vs-abi-filters.patch
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

## Size and CPU (estimates, not measured)

- Model: 7,983,136 bytes, shipped once as a Flutter asset (identical file and
  SHA-256 to the web clients — `c94d91f7…`, see `scripts/fetch-model.sh`).
- `libplotina_dfn.so` per ABI: expect 5–10 MB (tract runtime + DFN3 graph, no
  onnxruntime). For scale, the prebuilt Kaleyra AAR above ships 13.5 MB for
  arm64. Upstream's `flutter_webrtc` AAR already carries ~46 MiB of `.so` across
  four ABIs.
- Net APK growth for the universal APK (arm64-v8a + armeabi-v7a + x86_64):
  roughly +30–40 MB (model 8 MB, arm64 lib ~8 MB, armv7 lib ~6 MB, x86_64 lib
  ~8 MB).
- CPU: DFN3 is comfortably real time on a laptop core; on phones expect a few
  percent to low tens of percent of one core, and much worse on old armv7
  devices. Measure before believing this. The hard budget is 10 ms per frame —
  anything above that stutters the call, which is the first thing the CPU
  measurement tells you.

## Maintenance cost

- **Upstream bumps:** re-resolve `UPSTREAM_TAG` and re-check all four patches;
  `0001` touches an alphabetically sorted dependency block and `0004` a Gradle
  block, so `git apply -3` in the loop is the first thing to try. If one
  conflicts, apply that hunk by hand.
- **flutter_webrtc bumps:** we depend on `AudioProcessingAdapter`,
  `AudioProcessingAdapter.ExternalAudioFrameProcessing` and
  `FlutterWebRTCPlugin.audioProcessingController`, all public since 1.x. If they
  move, the plugin fails to compile — loud, not silent.
- **livekit_client:** untouched. We hook below it.
- **Rust:** `deep_filter` is a git dependency pinned to tag `v0.5.6` (DFN3 is not
  on crates.io past 0.2.5). Commit `rust/Cargo.lock` after the first successful
  CI run so builds are reproducible.

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

## First build checklist

Nothing below has run yet. Ordered by when it can fail.

**In the CI log**

1. `applying 0001-pubspec-add-plotina-dfn.patch` is followed by
   `plugin registered in upstream/pubspec.yaml` — the patch landed.
2. `Build native denoiser` prints three `libplotina_dfn.so` paths (arm64-v8a,
   armeabi-v7a, x86_64) with non-zero sizes and `cargo ndk` exits 0. Record the
   sizes; the estimates above are guesses until this line exists.
3. `Configure signing` either says `signed with alias plotina` or warns that the
   run produces a debug build because the keystore secret is missing.
4. `Verify APK contents` lists `lib/arm64-v8a/libplotina_dfn.so`,
   `lib/armeabi-v7a/libplotina_dfn.so`, `lib/x86_64/libplotina_dfn.so` and
   `assets/flutter_assets/packages/plotina_dfn/assets/DeepFilterNet3_onnx.tar.gz`.
   If this step fails, the APK would otherwise have shipped a silent no-op
   denoiser.

**In the APK**

```sh
unzip -l Plotina-FluffyChat.apk | grep -E 'libplotina_dfn|DeepFilterNet3'
```

Each `.so` appears once per ABI; the model tarball is 7,983,136 bytes.

**On the device**

5. `adb logcat -s PlotinaDfn` while opening a call shows
   `model extracted … (7983136 bytes)`, `DeepFilterNet3 ready, hop=480 samples`
   and `denoiser attached to flutter_webrtc capture post-processing`. An
   `initialize(48000 Hz, …)` line may appear before them, but only if the plugin
   won the race against `LiveKitClient.initialize()`; the denoiser works either
   way (a zero sample rate just means the frame size is trusted). The attach line
   appears only once a call screen has initialised flutter_webrtc; if it never
   appears, the registration race needs a Dart-side hook after
   `LiveKitClient.initialize()`.
6. `PlotinaDfn.status()` from a debug build returns
   `{available: true, enabled: true, attached: true, frameLength: 480}`.
7. A/B test: same room, two devices, one of them calling
   `PlotinaDfn.setEnabled(false)`. The far end should hear noticeably less noise
   from the denoised device; listen for pumping or artefacts on speech onsets,
   which is what double processing (WebRTC APM NS + DFN3) sounds like.
8. CPU while in a call: `adb shell top -H -p $(pidof chat.fluffy.fluffychat)`.
   Above ~10 ms of CPU per 10 ms frame (one core saturated) the call stutters.
9. No regression in voice messages (they do not go through this path) and in
   video calls.

**For a signed build**

Set `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS=plotina` and `ANDROID_KEY_PASSWORD`, as described in
[Signing](#signing). Without them the workflow builds a debug APK that installs
but cannot update an installed Plotina build.

## Licensing

Our code: AGPL-3.0-or-later, like upstream. DeepFilterNet (`deep_filter`
crate and the model) is MIT/Apache-2.0; the model is redistributed unchanged
from the upstream release.
