// SPDX-License-Identifier: AGPL-3.0-or-later
//!
//! JNI shim that runs DeepFilterNet3 over WebRTC capture audio.
//!
//! The Kotlin side is `cc.plotina.dfn.DfnNative` (`android/…/DfnNative.kt`).
//! Its five `native…` methods map to the `Java_cc_plotina_dfn_DfnNative_*`
//! symbols below; the names are resolved by the VM at call time, so the two
//! files have to be renamed together.
//!
//! flutter_webrtc calls us from webrtc-sdk's `ExternalAudioProcessor::Process()`,
//! which hands over **mono float32, 48 kHz, 10 ms** frames (480 samples) taken
//! from `AudioBuffer::channels()[0]` — see
//! `sdk/android/src/jni/pc/external_audio_processor.cc` in webrtc-sdk m150.
//! That is exactly DeepFilterNet3's native rate and hop size, so no resampling
//! or format conversion happens here.
//!
//! This file is compiled by `cargo ndk` in CI; it is not exercised by any test
//! in this repository.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::Mutex;

use df::tract::{DfParams, DfTract, RuntimeParams};
use jni::objects::{JFloatArray, JObject, JString};
use jni::sys::{jboolean, jfloat, jint, jlong, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;
use ndarray::{ArrayView2, ArrayViewMut2};

/// Everything the audio thread touches. `input` and `output` are preallocated:
/// the APM calls us 100 times per second and must not trigger allocations.
struct Dfn {
    tract: DfTract,
    hop: usize,
    input: Vec<f32>,
    output: Vec<f32>,
}

/// Boxed behind a raw pointer handed to Kotlin. The mutex is cheap and keeps
/// the shim safe if the APM ever calls from more than one thread.
struct Handle(Mutex<Dfn>);

/// Loads `model_path` (the DeepFilterNet3_onnx.tar.gz tarball) and returns an
/// opaque handle, or 0 on failure. `atten_lim_db` is the maximum attenuation in
/// dB; 100 means unlimited.
#[no_mangle]
pub extern "system" fn Java_cc_plotina_dfn_DfnNative_nativeCreate<'local>(
    mut env: JNIEnv<'local>,
    _this: JObject<'local>,
    model_path: JString<'local>,
    atten_lim_db: jfloat,
) -> jlong {
    let created = catch_unwind(AssertUnwindSafe(|| -> Option<jlong> {
        let path: String = env.get_string(&model_path).ok()?.into();
        let params = DfParams::new(PathBuf::from(path)).ok()?;
        let runtime = RuntimeParams::default_with_ch(1).with_atten_lim(atten_lim_db);
        let tract = DfTract::new(params, &runtime).ok()?;
        let hop = tract.hop_size;
        let state = Dfn {
            tract,
            hop,
            input: vec![0.0; hop],
            output: vec![0.0; hop],
        };
        Some(Box::into_raw(Box::new(Handle(Mutex::new(state)))) as jlong)
    }));
    match created {
        Ok(Some(handle)) => handle,
        _ => 0,
    }
}

/// DeepFilterNet hop size in samples (480 at 48 kHz), 0 for a dead handle.
#[no_mangle]
pub extern "system" fn Java_cc_plotina_dfn_DfnNative_nativeFrameLength<'local>(
    _env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
) -> jint {
    if handle == 0 {
        return 0;
    }
    let state = unsafe { &*(handle as *const Handle) };
    match state.0.lock() {
        Ok(dfn) => dfn.hop as jint,
        Err(_) => 0,
    }
}

/// Denoises `samples[0..frames]` in place. Returns false when the frame was
/// left untouched (wrong size, poisoned lock, model error) — the caller then
/// keeps the original audio.
#[no_mangle]
pub extern "system" fn Java_cc_plotina_dfn_DfnNative_nativeProcess<'local>(
    env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
    samples: JFloatArray<'local>,
    frames: jint,
) -> jboolean {
    if handle == 0 || frames <= 0 {
        return JNI_FALSE;
    }
    let count = frames as usize;
    let processed = catch_unwind(AssertUnwindSafe(|| -> bool {
        let state = unsafe { &*(handle as *const Handle) };
        let Ok(mut guard) = state.0.lock() else {
            return false;
        };
        let Dfn {
            tract,
            hop,
            input,
            output,
        } = &mut *guard;
        if count != *hop {
            return false;
        }
        if env
            .get_float_array_region(&samples, 0, &mut input[..count])
            .is_err()
        {
            return false;
        }
        let Ok(noisy) = ArrayView2::from_shape((1, count), &input[..count]) else {
            return false;
        };
        let Ok(enhanced) = ArrayViewMut2::from_shape((1, count), &mut output[..count]) else {
            return false;
        };
        if tract.process(noisy, enhanced).is_err() {
            return false;
        }
        env.set_float_array_region(&samples, 0, &output[..count])
            .is_ok()
    }));
    match processed {
        Ok(true) => JNI_TRUE,
        _ => JNI_FALSE,
    }
}

/// Changes the maximum attenuation of a live handle. `db` is 0–100: 0 makes
/// `DfTract::process` copy the input through, 100 removes the limit. Runs
/// under the same mutex as `nativeProcess`, so a frame in flight finishes
/// before the new value takes effect and the call itself is never interrupted.
/// Returns true when the value was applied.
#[no_mangle]
pub extern "system" fn Java_cc_plotina_dfn_DfnNative_nativeSetAttenLim<'local>(
    _env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
    atten_lim_db: jfloat,
) -> jboolean {
    if handle == 0 || !atten_lim_db.is_finite() {
        return JNI_FALSE;
    }
    let applied = catch_unwind(AssertUnwindSafe(|| -> bool {
        let state = unsafe { &*(handle as *const Handle) };
        let Ok(mut guard) = state.0.lock() else {
            return false;
        };
        guard.tract.set_atten_lim(atten_lim_db);
        true
    }));
    match applied {
        Ok(true) => JNI_TRUE,
        _ => JNI_FALSE,
    }
}

/// Frees the handle created by `nativeCreate`.
#[no_mangle]
pub extern "system" fn Java_cc_plotina_dfn_DfnNative_nativeDestroy<'local>(
    _env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
) {
    if handle == 0 {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        drop(Box::from_raw(handle as *mut Handle));
    }));
}
