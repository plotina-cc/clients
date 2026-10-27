# FluffyChat with DeepFilterNet3

Plotina's Android build of [FluffyChat](https://github.com/krille-chan/fluffychat)
with DeepFilterNet3 (DFN3) denoising on outgoing call audio, on by default, no
user action.

**Status: scaffold.** Nothing here has been built or run on a device yet. The
upstream reading below was done against the pinned tag; the Kotlin/Rust in
`plotina_dfn/` is written against that code but has never been compiled.

## Upstream

| | |
|---|---|
| Tag | `v2.11.3` (`UPSTREAM_TAG`), commit `6fc4920` |
| Flutter | `3.47.8` (upstream `.fvmrc`) |
| Call stack | `livekit_client` 2.13.1, `flutter_webrtc` 1.6.2+hotfix.4 (both from `pubspec.lock`) |
| Patch | one file, four added lines (`patches/`) |

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
- x86/x86_64 emulators are not built by the workflow; `DfnNative.available`
  stays false there and audio passes through untouched.
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
- Net APK growth for the arm64+armv7 APK: roughly +20–30 MB (model 8 MB, arm64
  lib ~8 MB, armv7 lib ~6 MB).
- CPU: DFN3 is comfortably real time on a laptop core; on phones expect a few
  percent to low tens of percent of one core, and much worse on old armv7
  devices. Measure before believing this. The hard budget is 10 ms per frame —
  anything above that stutters the call, which is the first thing the CPU
  measurement tells you.

## Maintenance cost

- **Upstream bumps:** re-resolve `UPSTREAM_TAG`; the patch touches an
  alphabetically sorted dependency block, so it usually applies with
  `git apply -3`. If it conflicts, re-add the four lines by hand.
- **flutter_webrtc bumps:** we depend on `AudioProcessingAdapter`,
  `AudioProcessingAdapter.ExternalAudioFrameProcessing` and
  `FlutterWebRTCPlugin.audioProcessingController`, all public since 1.x. If they
  move, the plugin fails to compile — loud, not silent.
- **livekit_client:** untouched. We hook below it.
- **Rust:** `deep_filter` is a git dependency pinned to tag `v0.5.6` (DFN3 is not
  on crates.io past 0.2.5). Commit `rust/Cargo.lock` after the first successful
  CI run so builds are reproducible.

## Building

CI: `.github/workflows/build-fluffychat.yml`, triggered by a `v*-plotina.*` tag
or `workflow_dispatch`. It clones upstream at the pinned tag, applies the patch,
builds the Rust library for arm64-v8a / armeabi-v7a / x86_64 with `cargo ndk`,
runs `flutter build apk --release --target-platform android-arm64,android-arm`
and uploads **`Plotina-FluffyChat.apk`** (artifact and release asset, same name
every time).

Signing secrets (required for an APK that can update an installed Plotina build):

| Secret | |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 plotina-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | optional, defaults to the store password |

Without them Gradle falls back to upstream's committed `dummy.keystore`. That
APK installs, but the key is public and shared by every build of this workflow:
it cannot update an install signed with our real key, and cannot update an
F-Droid/Play install at all. A signature change always means uninstall first,
which loses the local database unless a backup exists.

Locally: `fluffychat/scripts/build-android.sh` (needs Flutter 3.47.8, Rust with
Android targets, `cargo-ndk`, SDK+NDK, JDK 17).

## First-build checklist

Nothing below has been done yet; these are the things that can only fail at
build or on-device time.

1. `cargo ndk` produces three `.so` files; record their sizes.
2. `unzip -l Plotina-FluffyChat.apk`: `lib/arm64-v8a/libplotina_dfn.so` and
   `assets/flutter_assets/packages/plotina_dfn/assets/DeepFilterNet3_onnx.tar.gz`
   are present exactly once.
3. `flutter build` succeeds with `compileSdk = 37` on the runner (AGP may have to
   download platform 37 and the NDK).
4. On device, `adb logcat -s PlotinaDfn`: "denoiser attached" and
   "DeepFilterNet3 ready, hop=480". If the attach message never appears, the
   registration race against `LiveKitClient.initialize()` needs a Dart-side hook.
5. `PlotinaDfn.status()` from a debug build returns `frameLength: 480`.
6. A/B test: same room, two devices, one with `setEnabled(false)`. Listen for
   pumping/artefacts on speech onsets and for the far end hearing less noise.
7. CPU while in call: `adb shell top -H -p $(pidof chat.fluffy.fluffychat)`.
8. No regression in voice messages and video calls.

## Licensing

Our code: AGPL-3.0-or-later, like upstream. DeepFilterNet (`deep_filter`
crate and the model) is MIT/Apache-2.0; the model is redistributed unchanged
from the upstream release.
