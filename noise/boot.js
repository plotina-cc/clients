/*
 * Plotina noise suppression for Element Web.
 *
 * Two jobs:
 *   1. Wrap navigator.mediaDevices.getUserMedia so that microphone audio for
 *      Element Call (LiveKit) is post-processed by DeepFilterNet3.
 *   2. Inject a level slider into Settings -> Voice & Video, next to the
 *      stock "Noise suppression" toggle.
 *
 * Decisions about what counts as call audio live in logic.js (unit-tested in
 * tests/unit.html); this file only wires them to the browser.
 *
 * Deliberate limits:
 *   - Only call audio is processed. Element Web's voice-message recorder asks
 *     for audio with `{ ideal: ... }` constraints, Element Call passes plain
 *     booleans; logic.js keys off that difference.
 *   - The stock "Noise suppression" toggle stays the master switch: when the
 *     app asks for `noiseSuppression: false`, we do not touch the stream.
 *   - Any failure returns the untouched stream. A broken denoiser must never
 *     cost a call.
 */
(function () {
  "use strict";

  if (window.__plotinaNoiseLoaded) return;
  window.__plotinaNoiseLoaded = true;

  var L = window.PlotinaNoiseLogic;
  if (!L) {
    console.info("[plotina-noise] logic.js is missing; noise suppression stays disabled");
    return;
  }

  var ASSET_BASE = "/noise/dfn";
  var MODULE_URL = "/noise/vendor/dfn.esm.js";

  function log() {
    var args = Array.prototype.slice.call(arguments);
    console.info.apply(console, ["[plotina-noise]"].concat(args));
  }

  function readLevel() {
    try {
      var raw = localStorage.getItem(L.LEVEL_KEY);
      if (raw === null) return L.DEFAULT_LEVEL;
      return L.clampLevel(raw);
    } catch (e) {
      return L.DEFAULT_LEVEL;
    }
  }

  var level = readLevel();
  var instances = new Set();

  function setLevel(v, persist) {
    level = L.clampLevel(v);
    if (persist !== false) {
      try {
        localStorage.setItem(L.LEVEL_KEY, String(level));
      } catch (e) {
        /* private mode */
      }
    }
    instances.forEach(function (inst) {
      try {
        inst.setLevel(level);
      } catch (e) {
        log("could not apply level to a running processor", e);
      }
    });
    document.dispatchEvent(new CustomEvent("plotina-noise-level", { detail: level }));
  }

  /* ---------------------------------------------------------------- audio */

  var modulePromise = null;
  function loadModule() {
    if (!modulePromise) {
      modulePromise = import(MODULE_URL).catch(function (e) {
        modulePromise = null;
        throw e;
      });
    }
    return modulePromise;
  }

  async function attachProcessor(stream, videoTracks) {
    var mod = await loadModule();
    var Core = mod.DeepFilterNet3Core || (mod.default && mod.default.DeepFilterNet3Core);
    if (!Core) throw new Error("DeepFilterNet3Core is not exported by " + MODULE_URL);

    var ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    try {
      var core = new Core({
        sampleRate: 48000,
        noiseReductionLevel: level,
        assetConfig: { cdnUrl: ASSET_BASE },
      });
      await core.initialize();

      var node = await core.createAudioWorkletNode(ctx);
      var source = ctx.createMediaStreamSource(stream);
      var dest = ctx.createMediaStreamDestination();
      source.connect(node);
      node.connect(dest);

      var rawTrack = stream.getAudioTracks()[0];
      var cleanTrack = dest.stream.getAudioTracks()[0];
      if (!cleanTrack) throw new Error("processed track was not created");

      var instance = {
        setLevel: function (v) {
          core.setSuppressionLevel(v);
        },
      };
      instances.add(instance);

      var cleaned = false;
      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        instances.delete(instance);
        try { source.disconnect(); } catch (e) {}
        try { node.disconnect(); } catch (e) {}
        try { core.destroy(); } catch (e) {}
        try { ctx.close(); } catch (e) {}
        try { rawTrack.stop(); } catch (e) {}
      }
      cleanTrack.addEventListener("ended", cleanup, { once: true });

      await ctx.resume();

      var tracks = (videoTracks || []).concat([cleanTrack]);
      return new MediaStream(tracks);
    } catch (e) {
      try { ctx.close(); } catch (err) {}
      throw e;
    }
  }

  var md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === "function") {
    var original = md.getUserMedia.bind(md);
    var stats = { callRequests: 0, otherAudioRequests: 0, processed: 0, failed: 0 };

    md.getUserMedia = function (constraints) {
      var audio = constraints && constraints.audio;
      if (audio && typeof audio === "object" && typeof audio.noiseSuppression !== "boolean") {
        /* Voice messages and anything else that is not Element Call. Counted so
           an upstream change in constraint shape is visible from the console. */
        stats.otherAudioRequests += 1;
      }
      if (!L.shouldProcess(constraints) || level === 0) {
        return original(constraints);
      }
      stats.callRequests += 1;

      return original(L.rawAudioConstraints(constraints)).then(
        function (stream) {
          var video = stream.getVideoTracks();
          return attachProcessor(stream, video).then(
            function (processed) {
              stats.processed += 1;
              return processed;
            },
            function (e) {
              stats.failed += 1;
              log("falling back to browser audio:", e && e.message ? e.message : e);
              return stream;
            },
          );
        },
        function () {
          /* Some browsers reject unsupported constraint values; retry as asked. */
          return original(constraints);
        },
      );
    };

    window.__plotinaNoiseStats = stats;
  }

  /* ------------------------------------------------------------------- ui */

  var LABELS = ["Подавление шума", "Noise suppression"];
  var ROW_ID = "plotina-noise-row";

  function exactTextNode(label) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.trim() === label) {
        var el = node.parentElement;
        if (el && el.offsetParent !== null) return el;
      }
    }
    return null;
  }

  function findAnchor() {
    for (var i = 0; i < LABELS.length; i++) {
      var el = exactTextNode(LABELS[i]);
      if (!el) continue;
      var row = el;
      for (var depth = 0; depth < 8 && row.parentElement; depth++) {
        if (row.querySelector && row.querySelector("input[type=checkbox]")) return row;
        row = row.parentElement;
      }
    }
    return null;
  }

  function buildRow() {
    var s = L.strings(document.documentElement.lang || navigator.language);
    var row = document.createElement("div");
    row.id = ROW_ID;
    row.style.cssText = [
      "display:flex",
      "flex-wrap:wrap",
      "align-items:center",
      "gap:8px 12px",
      "margin:12px 0 4px 47px",
      "max-width:560px",
      "font:inherit",
    ].join(";");

    var label = document.createElement("label");
    label.htmlFor = "plotina-noise-range";
    label.textContent = s.title;
    label.style.cssText = "flex:0 0 auto;font:inherit;";

    var range = document.createElement("input");
    range.type = "range";
    range.id = "plotina-noise-range";
    range.min = "0";
    range.max = "100";
    range.step = "5";
    range.value = String(level);
    range.style.cssText = "flex:1 1 auto;accent-color:#17795a;";

    var value = document.createElement("span");
    value.id = "plotina-noise-value";
    value.textContent = String(level);
    value.style.cssText = "flex:0 0 3ch;text-align:right;font:inherit;opacity:.8;";

    range.addEventListener("input", function () {
      var v = L.clampLevel(range.value);
      value.textContent = String(v);
      setLevel(v);
    });

    var hint = document.createElement("div");
    hint.textContent = s.hint;
    hint.style.cssText = "flex-basis:100%;font-size:12px;opacity:.6;margin-top:-4px;";

    row.appendChild(label);
    row.appendChild(range);
    row.appendChild(value);
    row.appendChild(hint);
    return row;
  }

  function inject() {
    var existing = document.getElementById(ROW_ID);
    if (existing) {
      if (existing.isConnected) return;
      existing.remove();
    }
    var anchor = findAnchor();
    if (!anchor) return;
    anchor.insertAdjacentElement("afterend", buildRow());
    prefetchAssets();
  }

  var pending = false;
  function scheduleInject() {
    if (pending) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      try {
        inject();
      } catch (e) {
        log("settings injection failed", e);
      }
    }, 200);
  }

  var observer = new MutationObserver(scheduleInject);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleInject, { once: true });
  } else {
    scheduleInject();
  }

  /* -------------------------------------------------------------- warm-up */

  var prefetched = false;
  function prefetchAssets() {
    if (prefetched) return;
    prefetched = true;
    try {
      loadModule().catch(function () {});
      fetch(ASSET_BASE + "/v3/pkg/df_bg.wasm").catch(function () {});
      fetch(ASSET_BASE + "/v3/models/DeepFilterNet3_onnx.tar.gz").catch(function () {});
    } catch (e) {
      /* warming up is best-effort */
    }
  }

  window.__plotinaNoise = {
    get level() {
      return level;
    },
    setLevel: setLevel,
    defaultLevel: L.DEFAULT_LEVEL,
    isSupported: function () {
      return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
    },
  };
})();
