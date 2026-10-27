/*
 * Pure decision logic for the Plotina noise-suppression wrapper.
 *
 * Kept separate from boot.js so it can be unit-tested without a browser audio
 * stack: no DOM, no AudioContext, no globals beyond the exported object.
 */
(function (global) {
  "use strict";

  var LEVEL_KEY = "plotina.noise.level";
  var DEFAULT_LEVEL = 70;

  var STRINGS = {
    ru: { section: "Звук", title: "Уровень шумоподавления", hint: "0 — выключено, 70 — по умолчанию" },
    en: { section: "Sound", title: "Noise suppression level", hint: "0 disables it, 70 is the default" },
  };

  function clampLevel(value) {
    if (value === null || value === undefined || value === "") return DEFAULT_LEVEL;
    var n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_LEVEL;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /*
   * Element Call (LiveKit) asks for audio with plain booleans:
   *   { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
   * Element Web's voice-message recorder asks with constraints objects:
   *   { noiseSuppression: { ideal: true }, ... }
   * Only the first shape is a call.
   */
  function shouldProcess(constraints) {
    var audio = constraints && constraints.audio;
    if (!audio || typeof audio !== "object") return false;
    return typeof audio.noiseSuppression === "boolean" && audio.noiseSuppression !== false;
  }

  /* Ask the browser for raw audio: its own suppressor would fight DeepFilterNet.
     Echo cancellation and AGC stay exactly as the caller requested. */
  function rawAudioConstraints(constraints) {
    var out = {};
    Object.keys(constraints).forEach(function (key) {
      out[key] = constraints[key];
    });
    var audio = {};
    Object.keys(constraints.audio).forEach(function (key) {
      audio[key] = constraints.audio[key];
    });
    audio.noiseSuppression = false;
    out.audio = audio;
    return out;
  }

  function strings(lang) {
    var value = (lang || "").toLowerCase();
    if (!value) return STRINGS.ru;
    return value.indexOf("ru") === 0 ? STRINGS.ru : STRINGS.en;
  }

  global.PlotinaNoiseLogic = {
    LEVEL_KEY: LEVEL_KEY,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    clampLevel: clampLevel,
    shouldProcess: shouldProcess,
    rawAudioConstraints: rawAudioConstraints,
    strings: strings,
  };
})(window);
