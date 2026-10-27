//! JNI shim that runs DeepFilterNet3 over the microphone frames of the Element X Android call
//! stack.
//!
//! The Kotlin half is `PlotinaDfn.kt`, added by `patches/0001-element-call-android-plotina-dfn.patch`
//! to element-call-android. The contract between the two:
//!
//! * the buffer is 48 kHz, mono, little-endian PCM16, and its length is a whole number of frames
//!   (960 bytes = 480 samples = 10 ms);
//! * processing happens in place, on the caller's thread (the `MatrixRtcAudioIn` capture loop), and
//!   must stay well under the 10 ms the next `AudioRecord.read` gives it;
//! * nothing here allocates across the JNI boundary: the model state is behind the opaque handle
//!   the Kotlin class holds.
//!
//! The model is `DeepFilterNet3_onnx.tar.gz`, the same file the web build in `noise/vendor/` uses.
//! Its `config.ini` says `sr = 48000`, `hop_size = 480`, `fft_size = 960`, `conv_lookahead = 2`,
//! `df_lookahead = 2`, `df_order = 5` — 10 ms frames, 20 ms of algorithmic lookahead.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

use jni::objects::{JByteArray, JObject};
use jni::sys::{jbyte, jint, jlong};
use jni::JNIEnv;
use ndarray::{Array2, ArrayView2};

use df::tract::{DfParams, DfTract, RuntimeParams};

/// Ceiling on how much of the noise may be removed, in dB. 100 is "no limit", which is what the
/// DFN3 command line tool does by default. Lower it (e.g. 30) if consonants start to disappear on
/// cheap phone mics; it is the single useful knob in this file.
const ATTEN_LIMIT_DB: f32 = 100.0;

struct Denoiser {
    model: DfTract,
    hop: usize,
    noisy: Array2<f32>,
    enhanced: Array2<f32>,
}

impl Denoiser {
    fn new(sample_rate: i32, channels: i32) -> Option<Self> {
        // The capture path is mono by construction (`AudioFormat.CHANNEL_COUNT = 1`); the model
        // would take >1 channel but the interleaving would have to be undone, and nothing in the
        // app publishes one.
        if channels != 1 {
            return None;
        }
        let params = RuntimeParams::default_with_ch(1).with_atten_lim(ATTEN_LIMIT_DB);
        let model = DfTract::new(DfParams::default(), &params).ok()?;
        if model.sr != sample_rate as usize {
            return None;
        }
        let hop = model.hop_size;
        Some(Self {
            model,
            hop,
            noisy: Array2::zeros((1, hop)),
            enhanced: Array2::zeros((1, hop)),
        })
    }

    /// Denoises every whole `hop`-sized frame in `pcm`, in place. Frames the model rejects are
    /// left as captured: losing denoising for 10 ms is better than losing 10 ms of speech.
    fn process(&mut self, pcm: &mut [i16]) {
        for frame in pcm.chunks_exact_mut(self.hop) {
            for (dst, src) in self.noisy.row_mut(0).iter_mut().zip(frame.iter()) {
                *dst = f32::from(*src) / 32768.0;
            }
            let noisy: ArrayView2<f32> = self.noisy.view();
            if self.model.process(noisy, self.enhanced.view_mut()).is_err() {
                continue;
            }
            for (dst, src) in frame.iter_mut().zip(self.enhanced.row(0).iter()) {
                *dst = (src * 32768.0).clamp(-32768.0, 32767.0) as i16;
            }
        }
    }
}

/// Borrows the state the Kotlin class holds as a `Long`. Sound as long as the handle is either 0
/// or a pointer `nativeCreate` returned and `nativeDestroy` has not taken back.
unsafe fn state<'a>(handle: jlong) -> Option<&'a Mutex<Denoiser>> {
    if handle == 0 {
        None
    } else {
        Some(&*(handle as *const Mutex<Denoiser>))
    }
}

/// `PlotinaDfn.nativeCreate(sampleRate, channels)`: loads the model, returns 0 on any failure.
#[no_mangle]
pub extern "system" fn Java_io_element_android_call_impl_rtc_media_PlotinaDfn_nativeCreate<'local>(
    _env: JNIEnv<'local>,
    _this: JObject<'local>,
    sample_rate: jint,
    channels: jint,
) -> jlong {
    match catch_unwind(|| Denoiser::new(sample_rate, channels)) {
        Ok(Some(denoiser)) => Box::into_raw(Box::new(Mutex::new(denoiser))) as jlong,
        _ => 0,
    }
}

/// `PlotinaDfn.nativeProcess(handle, frame)`: denoises the byte array in place.
#[no_mangle]
pub extern "system" fn Java_io_element_android_call_impl_rtc_media_PlotinaDfn_nativeProcess<'local>(
    env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
    frame: JByteArray<'local>,
) {
    let state = match unsafe { state(handle) } {
        Some(state) => state,
        None => return,
    };
    // `JByteArray` is `Copy`, so both the read and the write-back below can name it.
    let bytes = match env.convert_byte_array(frame) {
        Ok(bytes) if bytes.len() % 2 == 0 => bytes,
        _ => return,
    };
    let mut pcm: Vec<i16> = bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0] as u8, pair[1] as u8]))
        .collect();

    let processed = catch_unwind(AssertUnwindSafe(|| match state.lock() {
        Ok(mut guard) => guard.process(&mut pcm),
        Err(poisoned) => poisoned.into_inner().process(&mut pcm),
    }));
    if processed.is_err() {
        return;
    }

    let mut out: Vec<jbyte> = Vec::with_capacity(bytes.len());
    for sample in &pcm {
        out.extend(sample.to_le_bytes().iter().map(|byte| *byte as jbyte));
    }
    let _ = env.set_byte_array_region(frame, 0, &out);
}

/// `PlotinaDfn.nativeDestroy(handle)`: frees the model. Idempotent at the Kotlin layer, which is
/// where the handle is zeroed.
#[no_mangle]
pub extern "system" fn Java_io_element_android_call_impl_rtc_media_PlotinaDfn_nativeDestroy<'local>(
    _env: JNIEnv<'local>,
    _this: JObject<'local>,
    handle: jlong,
) {
    if handle == 0 {
        return;
    }
    let _ = catch_unwind(|| unsafe {
        drop(Box::from_raw(handle as *mut Mutex<Denoiser>));
    });
}
