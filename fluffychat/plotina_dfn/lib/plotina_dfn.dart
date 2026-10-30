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

  /// DeepFilterNet hop size in samples (480 at 48 kHz = 10 ms), 0 if not ready.
  static Future<int> frameLength() async =>
      (await _channel.invokeMethod<int>('frameLength')) ?? 0;

  /// Diagnostic snapshot: {available, enabled, attached, frameLength, error}.
  static Future<Map<String, Object?>> status() async =>
      (await _channel.invokeMethod<Map<Object?, Object?>>('status'))
          ?.cast<String, Object?>() ??
      <String, Object?>{};
}
