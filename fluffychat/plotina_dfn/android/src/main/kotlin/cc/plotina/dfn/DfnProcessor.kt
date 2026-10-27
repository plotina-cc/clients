// SPDX-License-Identifier: AGPL-3.0-or-later
package cc.plotina.dfn

import android.util.Log
import com.cloudwebrtc.webrtc.audio.AudioProcessingAdapter
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Runs DeepFilterNet3 over WebRTC capture audio.
 *
 * flutter_webrtc calls this from
 * `MethodCallHandlerImpl.audioProcessingController.capturePostProcessing`, i.e.
 * from webrtc-sdk's `ExternalAudioProcessor::Process(AudioBuffer*)`, after the
 * built-in APM (AEC/NS/AGC) and before the encoder.
 *
 * Data contract, verified in webrtc-sdk m150
 * (`sdk/android/src/jni/pc/external_audio_processor.cc`):
 *   - mono, deinterleaved: only `audio->channels()[0]` is passed;
 *   - `float32` samples, direct ByteBuffer, `buffer_size * sizeof(float)` bytes
 *     where `buffer_size = kNsFrameSize * num_bands` = 160 * 3 = 480;
 *   - 10 ms per call: 480 samples at 48 kHz (`rate = num_frames * 100`).
 */
class DfnProcessor : AudioProcessingAdapter.ExternalAudioFrameProcessing {
    /** Native handle, 0 until the model is loaded. Written from a worker thread. */
    @Volatile
    var handle: Long = 0L

    /** Set from the UI; the audio thread only reads it. */
    @Volatile
    var bypass: Boolean = false

    /** Reported by the APM on the audio thread before the first frame. */
    @Volatile
    private var sampleRateHz: Int = 0

    /** Reused conversion buffer; the audio thread is the only writer. */
    private val pcm = FloatArray(MAX_FRAMES)

    override fun initialize(sampleRateHz: Int, numChannels: Int) {
        this.sampleRateHz = sampleRateHz
        Log.i(TAG, "initialize($sampleRateHz Hz, $numChannels ch)")
    }

    override fun reset(newRate: Int) {
        sampleRateHz = newRate
        Log.i(TAG, "reset($newRate Hz)")
    }

    override fun process(numBands: Int, numFrames: Int, buffer: ByteBuffer?) {
        if (bypass || !DfnNative.available) return
        val nativeHandle = handle
        if (nativeHandle == 0L || buffer == null) return
        if (!buffer.isDirect || buffer.isReadOnly) return
        // DeepFilterNet3 is trained at 48 kHz. If the APM ever hands us another
        // rate, pass audio through rather than resample badly.
        val rate = sampleRateHz
        if (rate != 0 && rate != SAMPLE_RATE) return

        val frames = minOf(numFrames, buffer.remaining() / BYTES_PER_SAMPLE)
        if (frames <= 0 || frames > pcm.size) return

        // NewDirectByteBuffer() produces a BIG_ENDIAN buffer; the samples are
        // native-endian float32.
        val floats = buffer.order(ByteOrder.nativeOrder()).asFloatBuffer()
        floats.get(pcm, 0, frames)
        if (!DfnNative.process(nativeHandle, pcm, frames)) return
        // get() moved the position to `frames`; put() writes at the position,
        // so rewind first or the denoised samples land after the original ones.
        floats.position(0)
        floats.put(pcm, 0, frames)
    }

    private companion object {
        const val TAG = "PlotinaDfn"
        const val SAMPLE_RATE = 48_000
        const val BYTES_PER_SAMPLE = 4
        const val MAX_FRAMES = 480 * 2 // 10 ms at 48 kHz, with room for safety
    }
}
