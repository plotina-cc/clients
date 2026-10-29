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

  /* Where this file is served from. Browsers always mount us at the domain
     root, but Element Desktop serves the webapp as vector://vector/webapp/, so
     an absolute "/noise/..." would miss the archive. document.currentScript is
     only set while a classic script runs, which is the one moment we need it. */
  var NOISE_BASE = (function () {
    var src = document.currentScript && document.currentScript.src;
    if (!src) return "/noise";
    return src.replace(/[^/]*$/, "").replace(/\/$/, "");
  })();
  var ASSET_BASE = NOISE_BASE + "/dfn";
  var MODULE_URL = NOISE_BASE + "/vendor/dfn.esm.js";

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

  /* Element Call marks its page: the microphone there is processed by the
     LiveKit track processor, so the wrapper must not touch it at all — no
     capture, no warm pool, no debug badge. */
  var CALL_APP = window.__plotinaEc === true;
  if (CALL_APP) return;

  var level = readLevel();
  // ?plotina-level=0..100 overrides the stored level for this page load.
  var qLevel = /[?&]plotina-level=(\d{1,3})\b/.exec(location.search);
  if (qLevel) level = L.clampLevel(qLevel[1]);
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
  var moduleReady = false;
  function loadModule() {
    if (!modulePromise) {
      modulePromise = import(MODULE_URL).then(
        function (mod) {
          moduleReady = true;
          return mod;
        },
        function (e) {
          modulePromise = null;
          throw e;
        },
      );
    }
    return modulePromise;
  }

  /* Two initialised cores are kept ready. Element Call asks for the microphone
     once on the pre-join screen and again when the call starts; with a single
     core the preview consumed it and the call fell back to raw audio. */
  var WARM_TARGET = 2;
  var warmPool = [];
  var warmPromise = null;
  var warmInFlight = false;
  var warmStarted = false;
  var warmError = null;

  function startWarm() {
    if (warmInFlight || warmPool.length >= WARM_TARGET) return;
    warmInFlight = true;
    warmStarted = true;
    try {
      fetch(ASSET_BASE + "/v3/pkg/df_bg.wasm").catch(function () {});
      fetch(ASSET_BASE + "/v3/models/DeepFilterNet3_onnx.tar.gz").catch(function () {});
    } catch (e) {
      /* best effort */
    }
    warmPromise = loadModule()
      .then(function (mod) {
        var Core = mod.DeepFilterNet3Core || (mod.default && mod.default.DeepFilterNet3Core);
        if (!Core) throw new Error("DeepFilterNet3Core is not exported");
        var core = new Core({
          sampleRate: 48000,
          noiseReductionLevel: level,
          assetConfig: { cdnUrl: ASSET_BASE },
        });
        return core.initialize().then(function () {
          return core;
        });
      })
      .then(function (core) {
        warmPool.push(core);
        window.__plotinaNoiseCoreReady = true;
      })
      .catch(function (e) {
        warmError = (e && e.message ? e.message : String(e)) || "unknown";
        log("warm-up failed", warmError);
      })
      .then(function () {
        warmInFlight = false;
        warmPromise = null;
        if (warmPool.length < WARM_TARGET) startWarm();
      });
  }

  function warmUp() {
    startWarm();
  }

  /* Take one ready core and immediately start refilling the pool. */
  function takeCore() {
    var core = warmPool.shift() || null;
    if (core) startWarm();
    return core;
  }

  async function attachProcessor(stream, videoTracks) {
    var mod = await loadModule();
    var Core = mod.DeepFilterNet3Core || (mod.default && mod.default.DeepFilterNet3Core);
    if (!Core) throw new Error("DeepFilterNet3Core is not exported by " + MODULE_URL);

    var ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    try {
      var core = takeCore();
      if (!core) {
        core = new Core({
          sampleRate: 48000,
          noiseReductionLevel: level,
          assetConfig: { cdnUrl: ASSET_BASE },
        });
        await core.initialize();
      }

      var node = await core.createAudioWorkletNode(ctx);
      var source = ctx.createMediaStreamSource(stream);
      var dest = ctx.createMediaStreamDestination();
      source.connect(node);
      node.connect(dest);
      // Diagnostic: ?plotina-mute=1 publishes silence. If the far side still
      // hears the microphone, LiveKit is not using the track we returned.
      if (/[?&]plotina-mute=1\b/.test(location.search)) {
        try { node.disconnect(); } catch (e) {}
      }

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
    md.__plotinaOriginal = original;
    var stats = { callRequests: 0, otherAudioRequests: 0, processed: 0, failed: 0, skipped: 0, retried: 0, last: "-" };

    md.getUserMedia = async function (constraints) {
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
      stats.last = "request";
      if (!warmPool.length) {
        /* The pre-join mic preview consumes the warm core, and the join request
           arrives milliseconds later. Wait for the refill briefly instead of
           handing back raw audio; only give up if it really is not coming. */
        warmUp();
        if (warmPromise) {
          var ready = await Promise.race([
            warmPromise.then(function () { return true; }, function () { return false; }),
            new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 3000); }),
          ]);
          if (!ready || !warmPool.length) {
            stats.skipped += 1;
            stats.last = ready ? "skipped (warm-up failed)" : "skipped (core not ready in 3s)";
            return original(constraints);
          }
        } else {
          stats.skipped += 1;
          stats.last = "skipped (no warm-up)";
          return original(constraints);
        }
      }

      return original(L.rawAudioConstraints(constraints)).then(
        function (stream) {
          var video = stream.getVideoTracks();
          return attachProcessor(stream, video).then(
            function (processed) {
              stats.processed += 1;
              stats.last = "processed ok";
              return processed;
            },
            function (e) {
              stats.failed += 1;
              stats.last = "processing failed: " + (e && (e.name || e.message) ? (e.name ? e.name + " " : "") + (e.message || "") : String(e)).slice(0, 90);
              log("falling back to browser audio:", e && e.message ? e.message : e);
              return stream;
            },
          );
        },
        function (err) {
          /* Some browsers reject unsupported constraint values; retry as asked. */
          stats.retried += 1;
          stats.last = "raw request rejected: " + String((err && (err.name + " " + err.message)) || err).slice(0, 90);
          return original(constraints);
        },
      );
    };

    window.__plotinaNoiseStats = stats;
  }

  /* ------------------------------------------------------------------- ui */

  var LABELS = ["Подавление шума", "Noise suppression"];
  var SECTIONS = ["Обработка звука", "Audio processing"];
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

  // Element renders settings toggles as input[type=checkbox] in some builds and as
  // a div[role=switch] in others; look for either.
  var TOGGLE_SELECTOR = 'input[type=checkbox], [role="switch"], [class*="toggle" i] input';

  function findAnchor() {
    for (var i = 0; i < LABELS.length; i++) {
      var el = exactTextNode(LABELS[i]);
      if (!el) continue;
      var row = el;
      for (var depth = 0; depth < 8 && row.parentElement; depth++) {
        if (row.querySelector && row.querySelector(TOGGLE_SELECTOR)) return row;
        row = row.parentElement;
      }
    }
    return null;
  }

  // Fallback for layouts where the row cannot be recognised: put the slider at the
  // end of the "Audio processing" section, right before the next heading.
  function findSectionAnchor() {
    for (var i = 0; i < SECTIONS.length; i++) {
      var heading = exactTextNode(SECTIONS[i]);
      if (!heading) continue;
      var section = heading.parentElement;
      for (var depth = 0; depth < 4 && section && section.parentElement; depth++) {
        var toggles = section.querySelectorAll(TOGGLE_SELECTOR);
        if (toggles.length) return toggles[toggles.length - 1].closest("div");
        section = section.parentElement;
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
    var anchor = findAnchor() || findSectionAnchor();
    if (!anchor) {
      log("no anchor for the settings row");
      return;
    }
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

  warmUp();

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

  /* Opt-in on-screen counters: https://call.plotina.cc/room?plotina-debug=1 */
  if (/[?&]plotina-debug=1\b/.test(location.search)) {
    var badge = document.createElement("div");
    badge.style.cssText = [
      "position:fixed", "left:8px", "bottom:8px", "z-index:2147483647",
      "background:rgba(0,0,0,.78)", "color:#fff", "font:12px/1.35 monospace",
      "padding:6px 8px", "border-radius:6px", "pointer-events:none",
      "white-space:pre",
    ].join(";");
    document.documentElement.appendChild(badge);
    setInterval(function () {
      var st = window.__plotinaNoiseStats || {};
      var state = (window.__plotinaNoiseCoreReady || warmPool.length)
        ? "ready"
        : (warmError ? "error: " + warmError : (warmStarted ? "warming" : "not started"));
      badge.textContent = [
        "DFN " + state,
        "calls " + (st.callRequests || 0),
        "processed " + (st.processed || 0),
        "skipped " + (st.skipped || 0),
        "retried " + (st.retried || 0),
        "failed " + (st.failed || 0),
        "pool " + warmPool.length + "/" + WARM_TARGET,
        "last: " + (st.last || "-"),
      ].join("\n");
    }, 1000);
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
