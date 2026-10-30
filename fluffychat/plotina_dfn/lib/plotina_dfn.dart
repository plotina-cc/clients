// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Control surface for the bundled DeepFilterNet3 denoiser. The Android side
// attaches itself to flutter_webrtc's capture post-processing automatically, so
// the app does not have to call anything for denoising to happen; these methods
// exist for a settings toggle and for diagnostics.

import 'package:flutter/services.dart';

class PlotinaDfn {
  static const MethodChannel _channel = MethodChannel('plotina_dfn');

  /// False when the native library is missing for this ABI (e.g. x86 builds)
  /// or the model failed to load. Calls then pass through unmodified.
  static Future<bool> isAvailable() async =>
      (await _channel.invokeMethod<bool>('isAvailable')) ?? false;

  /// Turns denoising on/off for the current and future calls.
  static Future<void> setEnabled(bool enabled) =>
      _channel.invokeMethod<void>('setEnabled', enabled);

  /// Maximum attenuation in dB, 0–100. 0 bypasses the denoiser (and keeps the
  /// model unloaded at startup); 100 means no limit. Takes effect on the next
  /// 10 ms audio frame, without restarting the call. Android only: elsewhere
  /// the channel is missing and the call is a no-op.
  static Future<void> setAttenLim(int db) async {
    try {
      await _channel.invokeMethod<void>('setAttenLim', db.clamp(0, 100));
    } on MissingPluginException {
      // No native side on this platform.
    } on PlatformException {
      // A missing .so must not break the settings page.
    }
  }

  /// DeepFilterNet hop size in samples (480 at 48 kHz = 10 ms), 0 if not ready.
  static Future<int> frameLength() async =>
      (await _channel.invokeMethod<int>('frameLength')) ?? 0;

  /// Diagnostic snapshot: {available, enabled, attenLimDb, attached,
  /// frameLength, error}.
  static Future<Map<String, Object?>> status() async =>
      (await _channel.invokeMethod<Map<Object?, Object?>>('status'))
          ?.cast<String, Object?>() ??
      <String, Object?>{};
}
