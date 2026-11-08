/*
 * Pure decision logic for the Plotina noise-suppression wrapper.
 *
 * Kept separate from boot.js so it can be unit-tested without a browser audio
 * stack: no DOM, no AudioContext, no globals beyond the exported object.
 */
(function (global) {
  "use strict";

  var LEVEL_KEY = "plotina.noise.level";
  var DEFAULT_LEVEL = 60;

  /* Experimental backend selector. "dfn3" is the shipped default; "dpdfnet4"
     is the DPDFNet ONNX backend (see vendor/dpdfnet.esm.js). A failed backend
     never costs a call: backendPlan() lists the fallback chain and boot.js
     always ends in raw browser audio if everything fails. */
  var BACKEND_KEY = "plotina.noise.backend";
  var BACKENDS = ["dfn3", "dpdfnet4"];
  var DEFAULT_BACKEND = "dfn3";
  var BACKEND_LABELS = { dfn3: "DFN3", dpdfnet4: "DPDFNet" };
  var RAW_BACKEND = "raw";

  var STRINGS = {
    ru: { section: "Звук", title: "Уровень шумоподавления", hint: "0 — выключено, 60 — по умолчанию", backend: "Шумоподавление", backendNote: "DPDFNet — экспериментальный бэкенд; при сбое автоматический откат на DFN3" },
    en: { section: "Sound", title: "Noise suppression level", hint: "0 disables it, 60 is the default", backend: "Noise suppression", backendNote: "DPDFNet is experimental; failures fall back to DFN3 automatically" },
  };

  function clampLevel(value) {
    if (value === null || value === undefined || value === "") return DEFAULT_LEVEL;
    var n = Number(value);
    if (!Number.isFinite(n)) return DEFAULT_LEVEL;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /* Normalise anything (storage junk, typos, case) to a known backend id. */
  function normalizeBackend(value) {
    if (typeof value !== "string") return DEFAULT_BACKEND;
    var v = value.trim().toLowerCase();
    for (var i = 0; i < BACKENDS.length; i++) {
      if (BACKENDS[i] === v) return v;
    }
    return DEFAULT_BACKEND;
  }

  /* Read ?plotina-backend=dfn3|dpdfnet4 from a query string ("?a&plotina-backend=x").
     Returns the raw valid id or null when absent/unknown, so callers can tell
     "no override" apart from "override to dfn3". */
  function parseBackendOverride(search) {
    if (typeof search !== "string") return null;
    var m = /[?&]plotina-backend=([a-z0-9_-]+)/i.exec(search);
    if (!m) return null;
    var v = m[1].toLowerCase();
    for (var i = 0; i < BACKENDS.length; i++) {
      if (BACKENDS[i] === v) return v;
    }
    return null;
  }

  /* Effective backend: URL override wins over stored, stored wins over default. */
  function resolveBackend(input) {
    var opts = input || {};
    var override = parseBackendOverride(opts.search);
    if (override) return override;
    if (opts.stored !== null && opts.stored !== undefined && opts.stored !== "") {
      return normalizeBackend(opts.stored);
    }
    return DEFAULT_BACKEND;
  }

  /* Fallback chain for a chosen backend: dpdfnet4 tries dfn3 next; dfn3 is
     already the last model before raw audio. Unknown input behaves like dfn3. */
  function backendPlan(name) {
    var b = normalizeBackend(name);
    if (b === "dpdfnet4") return ["dpdfnet4", "dfn3"];
    return [b];
  }

  /* Given a backend and the ids that were actually attempted in order, return
     the id that ended up carrying audio: the last attempted one, but "raw" if
     the caller appended the raw sentinel. boot.js appends "raw" when all
     model attempts failed. */
  function resolveBackendAfterAttempt(chosen, attempted) {
    var list = attempted || [];
    if (!list.length) return RAW_BACKEND;
    var last = list[list.length - 1];
    if (last === RAW_BACKEND || normalizeBackend(last) !== last) return RAW_BACKEND;
    return last;
  }

  /*
   * Element Call's current media handler asks with constraint objects:
   *   { noiseSuppression: { ideal: true }, ... }
   * Older Element Call releases used booleans, and some callers still do.
   * Element Web's voice-message recorder also uses the object form, but it
   * pins channelCount to 1; a call does not. Accept both truthy shapes and
   * keep the voice-message path raw. Explicit false (or ideal/exact false)
   * stays skipped, so the stock toggle remains the master switch.
   */
  function isRequested(value) {
    if (value === true) return true;
    if (!value || typeof value !== "object") return false;
    if (value.ideal === false || value.exact === false) return false;
    return value.ideal !== undefined || value.exact !== undefined || Object.keys(value).length > 0;
  }

  function shouldProcess(constraints) {
    var audio = constraints && constraints.audio;
    if (!audio || typeof audio !== "object") return false;
    if (!isRequested(audio.noiseSuppression)) return false;
    // Voice messages ask for mono; Element Call's microphone constraints do
    // not set channelCount.
    if (audio.channelCount === 1) return false;
    return true;
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
    // Android Chrome also exposes voiceIsolation; leaving it on means the OS
    // processes the capture before DeepFilterNet sees it, which the desktop
    // path never does. DeepFilterNet is the only processor here.
    if ("voiceIsolation" in audio) audio.voiceIsolation = false;
    out.audio = audio;
    return out;
  }

  /* Async core acquisition over the fallback plan, ports injected so it is
     unit-testable without a browser:
       ports.has(id)    -> is a core ready in the pool
       ports.take(id)   -> pop a ready core (or null)
       ports.dead(id)   -> no point waiting: warm-up already failed enough
       ports.kick(id)   -> start/keep a warm-up attempt going
       ports.wait(id)   -> Promise<boolean>: a core appeared within the budget
     Returns {id, core} or null (= raw audio). */
  async function acquireBackendCore(plan, ports) {
    var i, core;
    for (i = 0; i < plan.length; i++) {
      core = ports.take(plan[i]);
      if (core) return { id: plan[i], core: core };
      if (ports.dead(plan[i])) continue;
      ports.kick(plan[i]);
      await ports.wait(plan[i]);
      core = ports.take(plan[i]);
      if (core) return { id: plan[i], core: core };
    }
    /* A warm-up for a later/earlier entry may have finished while we waited;
       take whatever is ready before declaring raw audio. */
    for (i = 0; i < plan.length; i++) {
      core = ports.take(plan[i]);
      if (core) return { id: plan[i], core: core };
    }
    return null;
  }

  function strings(lang) {
    var value = (lang || "").toLowerCase();
    if (!value) return STRINGS.ru;
    return value.indexOf("ru") === 0 ? STRINGS.ru : STRINGS.en;
  }

  global.PlotinaNoiseLogic = {
    LEVEL_KEY: LEVEL_KEY,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    BACKEND_KEY: BACKEND_KEY,
    BACKENDS: BACKENDS,
    DEFAULT_BACKEND: DEFAULT_BACKEND,
    BACKEND_LABELS: BACKEND_LABELS,
    RAW_BACKEND: RAW_BACKEND,
    clampLevel: clampLevel,
    normalizeBackend: normalizeBackend,
    parseBackendOverride: parseBackendOverride,
    resolveBackend: resolveBackend,
    backendPlan: backendPlan,
    resolveBackendAfterAttempt: resolveBackendAfterAttempt,
    acquireBackendCore: acquireBackendCore,
    shouldProcess: shouldProcess,
    rawAudioConstraints: rawAudioConstraints,
    strings: strings,
  };
})(window);
