# Element X for Android, with DeepFilterNet3 in the microphone

Element X (element-hq/element-x-android) at a pinned tag, with the native call path patched so that
every captured frame is denoised by DeepFilterNet3 before it is published. Same intent as the
`noise/` layer we ship for Element Web and Cinny, at the only place Android offers: inside the
client.

**Status: scaffold. Nothing here has been through a CI run yet.** What is verified is written down
where it was verified; what is estimated says so.

Contents: [the premise](#the-premise-at-these-pins) ·
[pins](#pins) · [what the code does](#what-the-pinned-sources-actually-do) ·
[insertion point](#the-insertion-point) · [why JNI](#why-jni-to-rust-and-not-onnx-runtime-mobile) ·
[patches](#what-the-patches-change) · [building](#building) ·
[limitations](#limitations) · [cost](#cost) · [first build](#what-to-check-on-the-first-build)

---

## The premise at these pins

The brief for this directory assumed Element X places calls through
`io.livekit:livekit-android` over `webrtc-android`. At v26.10.1 it does not, and the difference
decides the whole design:

| | at v26.10.1 | denoiser reachable? |
| :-- | :-- | :-- |
| Default call path | The **bundled Element Call in a WebView**, `https://appassets.androidplatform.net/element-call/index.html` (`features/call/impl/.../utils/DefaultCallWidgetProvider.kt`, `EMBEDDED_CALL_WIDGET_BASE_URL`) | No. It is Element's own asset bundle, not our origin, so neither `noise/` nor a native hook applies. |
| Native call path | `FeatureFlags.NativeCall`, **default `false`** (`libraries/featureflag/api/.../FeatureFlags.kt:173`, `isFinished = false`) → `NativeCallEntryPoint` → the prebuilt `io.element.android:element-call` AAR → **matrix-rust-rtc** (Rust core, statically linked libwebrtc and LiveKit Rust client) | Only with `0001` below, and only if the flag is on (`0003`). |

So there are three ways to get DFN on Android, and this directory takes the third:

1. **Repoint the WebView** at our own Element Call (`call.plotina.cc`), which already runs `noise/`.
   One line, zero native code, no fork — but it keeps a WebView call (no native call UI, no PiP) and
   needs the deployment to stay in step. Worth doing independently of this directory.
2. **Wait for upstream** to finish the native stack; the flag is `isFinished = false` and the
   library is `0.1.0-rc.8`.
3. **This directory**: build the native path ourselves with the denoiser inside it, on by default.
   That is what is scaffolded below, and it is the option with the most moving parts.

## Pins

All of them live in `pins.env`, which the workflow reads.

| Component | Pin | Where it comes from |
| :-- | :-- | :-- |
| element-x-android | `v26.10.1` (`d1b523c4`) | our clone of the tag |
| element-call-android | `v0.1.0-rc.8` (`025078d6`) | our clone of the tag; Element X otherwise pulls it as an AAR from the GitHub release |
| matrix-rust-rtc | `v0.5.0-rc.5` AAR, sha256 `d5b86ff6…c428f8` | element-call's `gradle.properties`, fetched by its own `./tools/rtc/fetch-rust-rtc` |
| libDF (`deep_filter`) | `v0.5.6` | git dependency of `native/plotina-dfn` |
| DFN3 model | `DeepFilterNet3_onnx.tar.gz`, 7,983,136 bytes | embedded by libDF's `default-model` feature |
| NDK | `27.2.12479018` | pinned in `pins.env`; the runner's "latest" moves |

## What the pinned sources actually do

Read at the tags above, not from memory:

- **Element X does not implement calls.** `features/call/impl/.../DefaultElementCallEntryPoint.kt:48`
  reads `FeatureFlags.NativeCall` and routes to `nativeCallEntryPoint.startCall(callData)` or to the
  WebView activity. There is no LiveKit dependency in `gradle/libs.versions.toml` at all —
  `grep -i livekit` over the build files finds nothing.
- **element-call-android does not use the LiveKit Android SDK either.** No `LiveKit.create`, no
  `LocalAudioTrack`, no `AudioProcessorOptions`. `livekit.org.webrtc` appears only in
  `call/ui/.../video/CallTextureView.kt`, and a Konsist rule
  (`tests/konsist/.../KonsistBoundaryTest.kt:51`) forbids importing it outside `call.impl.rtc.media`
  and `call.ui.video`. Media is `matrix-rust-rtc`, shipped as `io.element.android:matrix-rtc-android`
  with `libmatrix_rtc_ffi.so`.
- **The microphone is opened in Kotlin, by the app.** `call/impl/src/main/kotlin/io/element/android/call/impl/rtc/media/AudioCapture.kt`
  builds `AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, 48_000, CHANNEL_IN_MONO, PCM_16BIT)`,
  reads 960-byte frames on a dedicated `MatrixRtcAudioIn` thread and hands each to
  `FfiLocalTrack.captureAudio(FfiAudioFrame(...))`. `AudioFormat.kt` next to it fixes 48 kHz, mono,
  480 samples, 10 ms.
- **The library documents exactly this** (`docs/INTEGRATION.md` §8): "48 kHz mono, 10 ms frames —
  that is what the RTC stack works in internally, so nothing has to resample… One frame is
  `480 samples × 2 bytes = 960 bytes` of little-endian int16". That is a better fit for DFN3 than
  any resampling wrapper could be.

### The LiveKit hook that exists but is not reachable here

For the record, because the brief expected it: `livekit/client-sdk-android` v2.29.2 **does** have a
first-class processor hook, and if Element X ever goes back to that SDK the cheap path is:

- `io.livekit.android.audio.AudioProcessorInterface` — `initializeAudioProcessing(sampleRateHz, numChannels)`,
  `resetAudioProcessing(newRate)`, `processAudio(numBands, numFrames, buffer)`, called every 10 ms;
- `io.livekit.android.audio.AudioProcessorOptions(capturePostProcessor = …)`, installed through
  `LiveKitOverrides(audioOptions = AudioOptions(audioProcessorOptions = …))` (`LiveKitOverrides.kt:142`,
  wired in `dagger/RTCModule.kt:328`, bridged by `webrtc/CustomAudioProcessingFactory.kt`);
- the buffer is a **direct `ByteBuffer` of float32, interleaved** — `sdk/android/src/jni/pc/external_audio_processing_factory.cc:52-56`
  passes `buffer_size * sizeof(float)` to `NewDirectByteBuffer`, with `numBands` = channels and
  `numFrames` = samples per channel. Not int16, which is the kind of detail that costs a day if
  assumed;
- it runs in APM as `capture_post_processor->Process(capture_buffer)` — after AEC/NS/AGC, before the
  frame leaves for the encoder (`modules/audio_processing/audio_processing_impl.cc:1428`), which is
  the same position our patch occupies by hand.

None of that is used by these pins. It is written down so the next person does not have to re-derive
it, and so that a future pin can switch to a 20-line `AudioProcessorInterface` instead of this patch.

## The insertion point

`AudioCapture.start()` — one call, in place, after the mute check and before `captureAudio`:

```
AudioRecord.read(960 B) → meter → [muted? skip] → PlotinaDfn.process(frame) → track.captureAudio(...)
```

Why there and not deeper:

- **Format match, no conversion.** 48 kHz / mono / int16 LE / 480 samples is exactly the model's
  `config.ini` (`sr = 48000`, `hop_size = 480`, `fft_size = 960`). No resampler, no re-framing, no
  float round-trip beyond the one the model needs anyway.
- **E2EE is untouched.** SFrame is applied to encoded frames further down, inside the Rust core. We
  modify samples before they are handed to it, so keys, IVs, frame counters and the SDP are all
  irrelevant to this change. Nothing here can weaken or break encryption; the worst case is that the
  far end gets noisier audio.
- **Latency.** DFN3 is causal with two frames of lookahead (`conv_lookahead = 2`, `df_lookahead = 2`
  in the model config) → **+20 ms** algorithmic, plus the per-frame compute (~2-4 ms on a recent
  arm64 phone, an estimate: measure on the first device). Total mouth-to-SFU in the 30-40 ms range,
  against a jitter buffer that is usually 40-200 ms. It is a real cost, and it is the one thing a
  user could notice on a bad network.
- **No stalls.** The capture loop is a blocking `AudioRecord.read` on its own `URGENT_AUDIO` thread
  with 100 ms of device buffer slack (`AudioFormat.MIN_DEVICE_BUFFER_BYTES`). Processing inline means
  a slow frame eats the slack rather than delaying the loop; the model load (~0.3-1.5 s, unmeasured)
  happens once, on that thread, before the first read, so it neither blocks a caller nor drops a
  frame — the far end simply hears nothing for the first second of the call.
- **Failure is quiet and safe.** Missing `.so` for the ABI, `UnsatisfiedLinkError`, a model that will
  not load, a panic in Rust: all of them turn `process()` into a no-op and the microphone is
  published as captured. A call never fails because of the denoiser.

## Why JNI to Rust, and not ONNX Runtime Mobile

DFN3 is more than three ONNX graphs. `DeepFilterNet3_onnx.tar.gz` contains `enc.onnx`,
`erb_dec.onnx`, `df_dec.onnx` and `config.ini`; the deep-filtering stage itself — a 5-tap complex
filter over `df_order = 5` frames of history with coefficients the decoder emits, plus STFT/ISTFT
windowing and the ERB filterbank — lives in libDF's Rust code, not in the graphs. ONNX Runtime Mobile
would run the three graphs and leave the part that makes DFN3 sound like DFN3 to be reimplemented in
Kotlin: FFT, ERB bank, mask application, deep filtering, normalisation state. Several hundred lines
of DSP that must match libDF bit-for-bit in behaviour, with no reference test unless we build one.

libDF is the reference implementation, is MIT OR Apache-2.0 (compatible with our AGPL-3.0 app), and
its ONNX runtime (`tract`) is pure Rust — so `rustup` + `cargo-ndk` cross-compiles it for Android
with no C++ toolchain, no ORT `.so` to ship, and no CMake in the build. The shim in
`native/plotina-dfn` is ~140 lines.

Cost: the model is `include_bytes!`d into the `.so`, so the APK grows by roughly 8 MB (model) plus
the tract runtime, expect **+10-14 MB** for arm64-v8a. That is unverified until the first build;
`unzip -l` on the APK settles it.

## What the patches change

Each applies with `git apply` to a fresh clone at the pinned tag; the CI `patches` job re-checks that
on every push to this directory.

| Patch | Applies to | Changes |
| :-- | :-- | :-- |
| `0001-element-call-android-plotina-dfn.patch` | element-call-android `v0.1.0-rc.8` | New `PlotinaDfn.kt` (JNI wrapper, lazy model load, no-op fallback, `@Keep`); `AudioCapture.kt` +12 lines (field, `prepare()` before the loop, `process()` before `captureAudio`, `close()` in `stop()`); `call/impl/build.gradle.kts` +3 (the `@Keep` annotation). |
| `0002-element-x-android-plotina-signing.patch` | element-x-android `v26.10.1` | A `plotina` signing config read from `PLOTINA_*` env vars, `release` signed with it instead of upstream's **debug** key, and `-PplotinaSingleApk` to build one APK instead of four ABI splits. |
| `0003-element-x-android-native-calls-default.patch` | element-x-android `v26.10.1` | `FeatureFlags.NativeCall` default `false → true`. Without it the build behaves like upstream: calls go to the bundled WebView and the denoiser is never reached. Skipped when the workflow is run with `native_calls: false`. |

**Element X itself needs no patch to consume the patched call library.** Upstream already ships the
seam: `settings.gradle.kts:98` adds `mavenLocal()` for `element-call-*` when
`-PelementCallLocalVersion` is set, and the three `features/callnative/*` build files take the BOM
version from that property. So the flow is: publish `element-call` to mavenLocal under
`0.1.0-rc.8-plotina.1` (a version that cannot be confused with upstream), then build Element X with
`-PelementCallLocalVersion=0.1.0-rc.8-plotina.1`.

The `.so` is packaged into the AAR (`call/impl/src/main/jniLibs/arm64-v8a/libplotina_dfn.so`) rather
than into the app, so the published artifact is self-contained. The workflow asserts it landed in
both the AAR and the APK — if it silently did not, the Kotlin side would fall back to raw capture and
everything would look fine.

## Building

CI (`.github/workflows/build-element-x.yml`), on tag `v*-plotina.*` or by hand:

1. `patches` job: clones both tags, `git apply --check` all three patches. Fails in two minutes if
   upstream moved.
2. `build` job: JDK 21, `platforms;android-37`, `build-tools;37.0.0`, NDK from `pins.env`, Rust with
   `aarch64-linux-android`, `cargo-ndk` → `libplotina_dfn.so` (asserted > 7 MB, or the model was not
   embedded) → clone element-call, apply `0001`, copy the `.so` in, `fetch-rust-rtc`,
   `publishToMavenLocal` → clone Element X, apply `0002`+`0003`, `assembleFdroidRelease` (or
   `assembleFdroidDebug` when no keystore is configured) → `Plotina-ElementX.apk` → artifact, and a
   GitHub release on tags via `GITHUB_TOKEN`.

Locally, the same steps by hand:

```sh
git clone --depth 1 -b v0.1.0-rc.8 https://github.com/element-hq/element-call-android /tmp/ec
git apply element-x/patches/0001-*.patch            # in /tmp/ec
mkdir -p /tmp/ec/call/impl/src/main/jniLibs/arm64-v8a
cargo ndk -t arm64-v8a -o element-x/native/plotina-dfn/jniLibs build --release   # in element-x/native/plotina-dfn
cp element-x/native/plotina-dfn/jniLibs/arm64-v8a/libplotina_dfn.so /tmp/ec/call/impl/src/main/jniLibs/arm64-v8a/
(cd /tmp/ec && ./tools/rtc/fetch-rust-rtc && ./gradlew publishToMavenLocal -PVERSION_NAME=0.1.0-rc.8-plotina.1)
git clone --depth 1 -b v26.10.1 https://github.com/element-hq/element-x-android /tmp/ex
git apply element-x/patches/0002-*.patch element-x/patches/0003-*.patch   # in /tmp/ex
(cd /tmp/ex && ./gradlew -PelementCallLocalVersion=0.1.0-rc.8-plotina.1 -PplotinaSingleApk assembleFdroidRelease)
```

Signing needs four secrets, because the key cannot live in the repo:

| Secret | What it is |
| :-- | :-- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 plotina.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | key alias |
| `ANDROID_KEY_PASSWORD` | key password |

Upstream signs `release` with the **debug** key, so an APK built without our `0002` can never be
updated in place — and neither can one built with a different key later. The first release under this
workflow defines the key for the lifetime of the app. Losing it means every user has to uninstall and
reinstall.

## Limitations

- **Android only.** No iOS. Apple's side is a different codebase with a different RTC stack, it needs
  a macOS runner and an Apple developer account, and neither exists here. This is not a "later, with
  more CI"; it is out of scope on this infrastructure.
- **arm64-v8a only** for the denoiser. armeabi-v7a, x86 and x86_64 install and run with the raw
  microphone (the fallback is silent apart from a log line). Building a 32-bit `.so` is one more
  `cargo ndk -t` target plus ~9 MB in the APK; not done until someone has a 32-bit phone.
- **Always on, no UI.** No per-call toggle, no settings row, no level meter of its own. Matches the
  "noise suppression without the user touching a setting" goal, but it also means no way to turn it
  off for music or a test call without rebuilding.
- **Experimental call stack.** `0003` turns on a stack upstream marks `isFinished = false`, at
  library version `0.1.0-rc.8`. Group calls, ringing, screen share and reconnection all go through
  matrix-rust-rtc; if it misbehaves, the denoiser is not the interesting part of the bug report.
- **Patch drift.** `0001` sits on `AudioCapture.kt`, a file that exists because upstream happens to
  keep capture in Kotlin. A bump of element-call-android can rename, move or rewrite it — the patch
  then fails loudly (good) and has to be re-cut (an hour, not a day). If upstream ever moves capture
  into the Rust core, the hook moves with it and the shim becomes a Rust-side processor in
  matrix-rust-rtc: less code, but a much heavier build (NDK + WebRTC).
- **Application id is unchanged** (`io.element.android.x`). Our APK does not install over Element X
  from Google Play — same id, different key. Uninstall first. Rebranding is one line in
  `plugins/src/main/kotlin/config/BuildTimeConfig.kt`, but it makes a separate app identity and
  abandons in-place updates from any earlier build that did not do it.
- **Model in the APK.** 8 MB embedded, no download, no network permission needed for it. Good for a
  private server, irrelevant for Play size budgets.

## Cost

Estimates, in agent-hours, for work that has not been done yet:

| Step | Hours | Notes |
| :-- | :-- | :-- |
| Research on pinned sources | 4-6 | Done, and it is what changed the design: the LiveKit premise did not survive contact with the code. |
| Scaffold (patches, shim, workflow) | 3-5 | Done. The Kotlin/Rust has not been compiled yet. |
| First green build | 8-14 | Gradle 9.8.2 + AGP 9 + compileSdk 37 + R8 on Element X is the bulk; tract on Android is the unknown. Expect the first three runs to fail on something boring (SDK package, NDK path, `@Keep`, a JNI symbol). |
| Audio QA and tuning | 6-10 | Two phones, a noisy room, A/B against the web build in `noise/`, `atten_lim` tuning, latency and battery measurement. |
| **Total to a shippable APK** | **~1.5-3 agent-days** | Plus ~2-4 h of CI machine time at ~40 min per run. |

Machine time per build: **60-90 min** cold, **25-40 min** warm (Gradle cache + rust-cache). The
element-call publish step alone is ~10-15 min; Element X's R8 is the other half.

Blockers, in the order they will bite:

1. **Keystore.** Nothing ships until someone generates `plotina.jks` and puts it in the four secrets.
   Not a technical blocker, but a decision: this key is permanent.
2. **`platforms;android-37`.** If that package is not in the stable SDK channel, the workflow fails at
   `sdkmanager`. Fix: `--channel=3`, or pin Element X one tag back.
3. **NDK + cargo.** The `.so` build is the only part with no fallback. If `tract` fails to
   cross-compile (it should not; it is pure Rust), the alternative is `deep_filter` with feature
   `onnx` + a prebuilt ORT `.so` — more moving parts, and the reason it is plan B.
4. **APK size.** +10-14 MB. Nobody will block on it here; it is worth knowing before the first
   upload.
5. **No iOS.** Permanent, as above.

## What to check on the first build

1. `patches` job green — all three `git apply --check` pass at the pins.
2. `unzip -l` on the AAR **and** the APK both contain `lib/arm64-v8a/libplotina_dfn.so` (the workflow
   asserts it; check the size is ~8 MB or more — the model is inside it, a few hundred KB means
   `default-model` fell out of the feature list).
3. On the first call, `adb logcat | grep Plotina` says `DeepFilterNet3 ready at 48000 Hz`. If it says
   `unavailable, publishing raw microphone`, the fallback is doing its job and hiding a real failure —
   the exception in the same line says which.
4. Ten-minute call: `dumpsys meminfo` shows the model resident (~40-60 MB), and it is gone again after
   hang-up (a second call must reload it — check the log line twice).
5. No under-runs: `dumpsys media.audio_flinger` and logcat for `AudioRecord.read failed` or the short
   read warning in `AudioCapture`. A frame that overruns 10 ms eats the 100 ms buffer slack; enough of
   them and the far end hears crackle.
6. Subjective A/B against the same call through the web build: same voice, less room. Tune
   `ATTEN_LIMIT_DB` in `native/plotina-dfn/src/lib.rs` if consonants suffer.
7. Mute → unmute → mute; the test tone (`setAudioTestToneEnabled`); a second call after the first ends.
8. An encrypted call with a second participant: key exchange, then audio. This change should be
   invisible to it — verify rather than assume.
9. Latency: two phones side by side, count the offset; compare against the same build with
   `native_calls: false` (WebView) to see what 20 ms plus WebView overhead actually adds.
10. Battery: 15 minutes of call, `dumpsys batterystats` with and without the `.so` in the APK.

## Open items

- `native/plotina-dfn/Cargo.lock` is not committed: there is no Rust toolchain on the machine this
  scaffold was written on. The first CI run resolves the graph — commit the lock from it so the
  transitive dependencies stop floating.
- No instrumented test. The honest test is a recording of a noisy room pushed through
  `PlotinaDfn.process` on a device, compared with libDF's own CLI output on the same file; that needs
  a device and half a day.
- `0003` is a product decision as much as a patch: shipping an experimental call stack to a community
  to get noise suppression may be the wrong trade against repointing the WebView at `call.plotina.cc`.
  Both are one line; only one of them can be undone by a user.
