// SPDX-License-Identifier: AGPL-3.0-or-later
package cc.plotina.dfn

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cloudwebrtc.webrtc.FlutterWebRTCPlugin
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Attaches [DfnProcessor] to flutter_webrtc's capture post-processing chain.
 *
 * flutter_webrtc owns the only `AudioProcessingController` in the process and
 * exposes it as `FlutterWebRTCPlugin.sharedSingleton.audioProcessingController`
 * (created in `MethodCallHandlerImpl.initialize()`, which livekit_client
 * triggers via `LiveKitClient.initialize()`). We therefore poll for it instead
 * of patching flutter_webrtc: registration has to happen after the peer
 * connection factory exists but before the first call starts.
 */
class PlotinaDfnPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var appContext: Context? = null
    private var flutterAssets: FlutterPlugin.FlutterAssets? = null
    private val processor = DfnProcessor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var worker: ExecutorService? = null

    @Volatile
    private var attached = false

    /** Set while the engine goes away, so an in-flight model load cleans up. */
    @Volatile
    private var released = false

    @Volatile
    private var initError: String? = null
    private var attempts = 0

    /** Saved strength in dB, 0–100. 0 means bypass and no model load. */
    @Volatile
    private var attenLimDb: Float = DEFAULT_ATTEN_LIM_DB

    /** PlotinaDfn.setEnabled(false); kept apart so a level change cannot undo it. */
    @Volatile
    private var userEnabled = true

    /** Set while a model load is queued or running, so slider moves do not pile up. */
    private val loading = AtomicBoolean(false)

    private val registerTask = object : Runnable {
        override fun run() {
            if (attached || released) return
            if (tryAttach()) {
                attached = true
                Log.i(TAG, "denoiser attached to flutter_webrtc capture post-processing")
                return
            }
            // LiveKitClient.initialize() — and with it flutter_webrtc's
            // AudioDeviceModule — only runs when the first call screen opens,
            // which can be hours after launch. Poll fast for the first seconds,
            // then slowly forever; one main-thread message per 2 s is free.
            attempts++
            mainHandler.postDelayed(this, if (attempts < FAST_ATTEMPTS) FAST_MS else SLOW_MS)
        }
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        appContext = binding.applicationContext
        flutterAssets = binding.flutterAssets
        released = false
        attached = false
        attempts = 0
        initError = null
        userEnabled = true
        loading.set(false)
        // Dart's main() has not run yet, so the saved level is read straight
        // from Flutter's SharedPreferences; at 0 the model is never loaded.
        attenLimDb = readSavedAttenLim(binding.applicationContext)
        processor.bypass = attenLimDb <= 0f
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also {
            it.setMethodCallHandler(this)
        }
        mainHandler.post(registerTask)
        worker = Executors.newSingleThreadExecutor()
        if (attenLimDb > 0f) {
            scheduleLoad()
        } else {
            Log.i(TAG, "noise suppression is off (0 dB), model not loaded")
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        released = true
        mainHandler.removeCallbacks(registerTask)
        channel?.setMethodCallHandler(null)
        channel = null
        detach()
        val handle = processor.handle
        processor.handle = 0L
        DfnNative.destroy(handle)
        loading.set(false)
        worker?.shutdown()
        worker = null
        appContext = null
        flutterAssets = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "isAvailable" -> result.success(DfnNative.available && processor.handle != 0L)
            "setEnabled" -> {
                userEnabled = (call.arguments as? Boolean) ?: true
                processor.bypass = !userEnabled || attenLimDb <= 0f
                result.success(null)
            }
            "setAttenLim" -> {
                val db = (call.arguments as? Number)?.toFloat()
                if (db == null || !db.isFinite()) {
                    result.error("bad_args", "setAttenLim expects a number", null)
                    return
                }
                applyAttenLim(db)
                result.success(null)
            }
            "frameLength" -> result.success(DfnNative.frameLength(processor.handle))
            "status" -> result.success(
                mapOf(
                    "available" to DfnNative.available,
                    "enabled" to !processor.bypass,
                    "attenLimDb" to attenLimDb,
                    "attached" to attached,
                    "frameLength" to DfnNative.frameLength(processor.handle),
                    "error" to initError,
                ),
            )
            else -> result.notImplemented()
        }
    }

    private fun tryAttach(): Boolean = try {
        val controller = FlutterWebRTCPlugin.sharedSingleton?.audioProcessingController
        if (controller == null) {
            false
        } else {
            controller.capturePostProcessing.addProcessor(processor)
            true
        }
    } catch (t: Throwable) {
        // flutter_webrtc is still attaching: methodCallHandler is not set yet.
        false
    }

    private fun detach() {
        if (!attached) return
        try {
            FlutterWebRTCPlugin.sharedSingleton?.audioProcessingController
                ?.capturePostProcessing
                ?.removeProcessor(processor)
        } catch (t: Throwable) {
            Log.w(TAG, "detach failed: ${t.message}")
        }
        attached = false
    }

    /**
     * Applies a new attenuation limit to the running processor. A positive
     * value goes straight into the Rust handle, so a call keeps running; 0
     * only flips the bypass flag and never reaches the audio path.
     */
    private fun applyAttenLim(db: Float) {
        attenLimDb = db.coerceIn(0f, MAX_ATTEN_LIM_DB)
        processor.bypass = !userEnabled || attenLimDb <= 0f
        if (attenLimDb <= 0f) {
            Log.i(TAG, "noise suppression off (0 dB)")
            return
        }
        val handle = processor.handle
        if (handle == 0L) {
            // The saved value was 0 at startup, so no model was loaded.
            scheduleLoad()
        } else if (!DfnNative.setAttenLim(handle, attenLimDb)) {
            Log.w(TAG, "could not apply ${attenLimDb} dB to the running handle")
        }
    }

    /** Queues loadModel() unless a load is already running or a handle exists. */
    private fun scheduleLoad() {
        if (released || !DfnNative.available || processor.handle != 0L) return
        if (!loading.compareAndSet(false, true)) return
        val executor = worker
        if (executor == null) {
            loading.set(false)
            return
        }
        executor.execute {
            try {
                loadModel()
            } finally {
                loading.set(false)
            }
        }
    }

    /**
     * shared_preferences stores Dart ints as longs in `FlutterSharedPreferences`
     * with a `flutter.` key prefix. Reading it here is what keeps the model
     * unloaded when the saved level is 0: Dart only runs after this call.
     */
    private fun readSavedAttenLim(context: Context): Float = try {
        context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
            .getLong(PREFS_PREFIX + PREF_KEY, DEFAULT_ATTEN_LIM_DB.toLong())
            .coerceIn(0L, MAX_ATTEN_LIM_DB.toLong())
            .toFloat()
    } catch (t: Throwable) {
        Log.w(TAG, "cannot read the saved noise level: ${t.message}")
        DEFAULT_ATTEN_LIM_DB
    }

    /**
     * Copies the model out of the APK once and loads it. Asset files are not
     * real files, and libDF wants a path, hence the copy. Writes through a
     * temp file so a process killed mid-copy cannot leave a truncated model
     * that would fail to load forever after.
     */
    private fun loadModel() {
        val context = appContext ?: return
        val assets = flutterAssets ?: return
        // A slider move to 0 can land while this task is queued.
        if (attenLimDb <= 0f) return
        if (!DfnNative.available) {
            initError = "native library missing for this ABI"
            return
        }
        try {
            val dir = File(context.filesDir, "plotina_dfn").apply { mkdirs() }
            val model = File(dir, MODEL_NAME)
            if (!model.exists() || model.length() != MODEL_BYTES) {
                val key = assets.getAssetFilePathByName(MODEL_ASSET, PACKAGE)
                val tmp = File(dir, "$MODEL_NAME.tmp")
                context.assets.open(key).use { input ->
                    tmp.outputStream().use { output -> input.copyTo(output) }
                }
                val copied = tmp.length()
                if (copied != MODEL_BYTES) {
                    tmp.delete()
                    initError = "model asset is $copied bytes, expected $MODEL_BYTES"
                    Log.e(TAG, initError!!)
                    return
                }
                if (released) {
                    tmp.delete()
                    return
                }
                if (!tmp.renameTo(model)) {
                    tmp.delete()
                    initError = "could not move the model into place"
                    Log.e(TAG, initError!!)
                    return
                }
                Log.i(TAG, "model extracted to ${model.absolutePath} (${model.length()} bytes)")
            }
            val level = attenLimDb
            val handle = DfnNative.create(model.absolutePath, level)
            if (handle == 0L) {
                initError = "DeepFilterNet3 model failed to load"
                Log.e(TAG, initError!!)
                return
            }
            if (released || attenLimDb <= 0f) {
                DfnNative.destroy(handle)
                return
            }
            processor.handle = handle
            // A slider move may have landed while the model was loading.
            DfnNative.setAttenLim(handle, attenLimDb)
            Log.i(
                TAG,
                "DeepFilterNet3 ready, ${attenLimDb} dB, hop=${DfnNative.frameLength(handle)} samples",
            )
        } catch (t: Throwable) {
            initError = t.message ?: t.javaClass.simpleName
            Log.e(TAG, "model init failed", t)
        }
    }

    private companion object {
        const val TAG = "PlotinaDfn"
        const val CHANNEL = "plotina_dfn"
        const val PACKAGE = "plotina_dfn"
        const val MODEL_ASSET = "assets/DeepFilterNet3_onnx.tar.gz"
        const val MODEL_NAME = "DeepFilterNet3_onnx.tar.gz"

        /** Size of the pinned tarball; see scripts/fetch-model.sh. */
        const val MODEL_BYTES = 7_983_136L

        /** Default maximum attenuation in dB; also the value a fresh install gets. */
        const val DEFAULT_ATTEN_LIM_DB = 40f

        /** 100 dB means no attenuation limit (libDF treats >= 100 as unlimited). */
        const val MAX_ATTEN_LIM_DB = 100f

        // The same key as AppSettings.noiseSuppressionLevel in patch 0006. Dart's
        // shared_preferences prefixes keys with `flutter.` on Android.
        const val PREF_KEY = "chat.fluffy.noise_suppression_level"
        const val PREFS_FILE = "FlutterSharedPreferences"
        const val PREFS_PREFIX = "flutter."

        const val FAST_MS = 200L
        const val FAST_ATTEMPTS = 50 // 10 s of fast polling after engine attach
        const val SLOW_MS = 2_000L
    }
}
