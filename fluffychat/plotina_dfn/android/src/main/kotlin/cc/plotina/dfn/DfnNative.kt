// SPDX-License-Identifier: AGPL-3.0-or-later
package cc.plotina.dfn

/**
 * Thin JNI surface over the Rust crate in `rust/` (libplotina_dfn.so).
 *
 * The library is built per ABI by `cargo ndk`; when it is missing for the ABI
 * the app was built for (we do not build x86), loading fails and
 * [available] stays false, so callers pass audio through untouched.
 */
object DfnNative {
    val available: Boolean = try {
        System.loadLibrary("plotina_dfn")
        true
    } catch (t: Throwable) {
        android.util.Log.w("PlotinaDfn", "libplotina_dfn.so not loadable: ${t.message}")
        false
    }

    /** Returns an opaque handle, or 0 if the model could not be loaded. */
    external fun create(modelPath: String, attenLimDb: Float): Long

    /** DeepFilterNet hop size in samples, 0 if [handle] is invalid. */
    external fun frameLength(handle: Long): Int

    /**
     * Denoises [frames] float32 samples of [samples] in place at 48 kHz mono.
     * Returns false if the frame was not processed; the caller then leaves the
     * buffer as it was.
     */
    external fun process(handle: Long, samples: FloatArray, frames: Int): Boolean

    external fun destroy(handle: Long)
}
