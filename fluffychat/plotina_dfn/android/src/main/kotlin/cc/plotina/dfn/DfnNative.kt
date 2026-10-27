// SPDX-License-Identifier: AGPL-3.0-or-later
package cc.plotina.dfn

/**
 * Thin JNI surface over the Rust crate in `rust/` (libplotina_dfn.so).
 *
 * The library is built per ABI by `cargo ndk`; when it is missing for the ABI
 * the app was built for (there is no 32-bit x86 build), loading fails and
 * [available] stays false, so callers pass audio through untouched.
 *
 * The public functions below never touch JNI when the library is absent: a
 * native method whose library failed to load throws UnsatisfiedLinkError even
 * for a null-looking handle, which would break the method channel on x86.
 *
 * The four `native…` declarations map to
 * `Java_cc_plotina_dfn_DfnNative_native…` in `rust/src/lib.rs`.
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
    fun create(modelPath: String, attenLimDb: Float): Long =
        if (available) nativeCreate(modelPath, attenLimDb) else 0L

    /** DeepFilterNet hop size in samples, 0 if [handle] is invalid. */
    fun frameLength(handle: Long): Int =
        if (available && handle != 0L) nativeFrameLength(handle) else 0

    /**
     * Denoises [frames] float32 samples of [samples] in place at 48 kHz mono.
     * Returns false if the frame was not processed; the caller then leaves the
     * buffer as it was.
     */
    fun process(handle: Long, samples: FloatArray, frames: Int): Boolean =
        available && handle != 0L && frames > 0 && nativeProcess(handle, samples, frames)

    fun destroy(handle: Long) {
        if (available && handle != 0L) nativeDestroy(handle)
    }

    private external fun nativeCreate(modelPath: String, attenLimDb: Float): Long

    private external fun nativeFrameLength(handle: Long): Int

    private external fun nativeProcess(handle: Long, samples: FloatArray, frames: Int): Boolean

    private external fun nativeDestroy(handle: Long)
}
