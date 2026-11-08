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

  /* Backend selection: ?plotina-backend= > localStorage > dfn3. While a URL
     override is present the selector reflects it but does not overwrite the
     stored preference. */
  var backendOverride = L.parseBackendOverride(location.search);
  function readStoredBackend() {
    try {
      return localStorage.getItem(L.BACKEND_KEY);
    } catch (e) {
      return null;
    }
  }
  var backend = L.resolveBackend({ stored: readStoredBackend(), search: location.search });

  var stats = {
    callRequests: 0, otherAudioRequests: 0, processed: 0, failed: 0, skipped: 0, retried: 0,
    // which backend the user selected, and which one actually carried audio
    // ("dfn3" | "dpdfnet4" | "raw")
    requestedBackend: backend,
    backend: backend,
    last: "-",
  };

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

  /*
   * One registry, unified backend interface:
   *   load() -> module; def.createCore(mod) -> core implementing
   *   initialize(), createAudioWorkletNode(ctx), setSuppressionLevel(v),
   *   destroy(). vendor/dfn.esm.js is *not* modified; DFN3 gets an adapter
   *   here, DPDFNet (vendor/dpdfnet.esm.js) implements the interface itself.
   */
  var DPDFNET_DIR = NOISE_BASE + "/vendor/dpdfnet/dpdfnet2_48khz_hr";
  var ORT_DIR = NOISE_BASE + "/vendor/ort";
  var BACKEND_DEFS = {
    dfn3: {
      moduleUrl: MODULE_URL,
      prefetch: [ASSET_BASE + "/v3/pkg/df_bg.wasm", ASSET_BASE + "/v3/models/DeepFilterNet3_onnx.tar.gz"],
      createCore: function (mod) {
        var Core = mod.DeepFilterNet3Core || (mod.default && mod.default.DeepFilterNet3Core);
        if (!Core) throw new Error("DeepFilterNet3Core is not exported by " + MODULE_URL);
        return new Core({
          sampleRate: 48000,
          noiseReductionLevel: level,
          assetConfig: { cdnUrl: ASSET_BASE },
        });
      },
    },
    dpdfnet4: {
      moduleUrl: NOISE_BASE + "/vendor/dpdfnet.esm.js",
      prefetch: [
        DPDFNET_DIR + "/model_stateful.onnx",
        DPDFNET_DIR + "/initial_states.bin",
        ORT_DIR + "/ort.wasm.bundle.min.mjs",
        ORT_DIR + "/ort-wasm-simd-threaded.mjs",
        ORT_DIR + "/ort-wasm-simd-threaded.wasm",
      ],
      createCore: function (mod) {
        if (!mod.createCore) throw new Error("createCore is not exported by the dpdfnet module");
        return mod.createCore({
          sampleRate: 48000,
          noiseReductionLevel: level,
          ortUrl: ORT_DIR + "/ort.wasm.bundle.min.mjs",
          wasmUrl: ORT_DIR + "/ort-wasm-simd-threaded.wasm",
          assetConfig: {
            modelUrl: DPDFNET_DIR + "/model_stateful.onnx",
            statesJsonUrl: DPDFNET_DIR + "/initial_states.json",
            statesBinUrl: DPDFNET_DIR + "/initial_states.bin",
          },
        });
      },
    },
  };

  var modulePromises = {};
  function loadModule(id) {
    var def = BACKEND_DEFS[id];
    if (!def) return Promise.reject(new Error("unknown noise backend: " + id));
    if (!modulePromises[id]) {
      modulePromises[id] = import(def.moduleUrl).catch(function (e) {
        modulePromises[id] = null;
        throw e;
      });
    }
    return modulePromises[id];
  }

  /* Two initialised cores are kept ready. Element Call asks for the microphone
     once on the pre-join screen and again when the call starts; with a single
     core the preview consumed it and the call fell back to raw audio.
     Pools are keyed by backend id; warmFailures bounds retries so a missing
     asset directory cannot hammer the server, but every user action (a dial,
     a backend switch) forces a fresh attempt. */
  var WARM_TARGET = 2;
  var warmPool = []; // [{id, core}]
  var warmPromise = null;
  var warmInFlight = false;
  var warmTarget = null;
  var warmStarted = false;
  var warmError = null;
  var warmFailures = {}; // per backend id
  var WARM_MAX_FAILURES = 3;

  function warmPoolCount(id) {
    var n = 0;
    for (var i = 0; i < warmPool.length; i++) if (warmPool[i].id === id) n++;
    return n;
  }

  function startWarm(id) {
    if (warmInFlight || warmPoolCount(id) >= WARM_TARGET) return;
    if ((warmFailures[id] || 0) >= WARM_MAX_FAILURES) return;
    var def = BACKEND_DEFS[id];
    if (!def) return;
    warmInFlight = true;
    warmTarget = id;
    warmStarted = true;
    def.prefetch.forEach(function (url) {
      try {
        fetch(url).catch(function () {});
      } catch (e) {
        /* best effort */
      }
    });
    warmPromise = loadModule(id)
      .then(function (mod) {
        var core = def.createCore(mod);
        return core.initialize().then(function () {
          return { id: id, core: core };
        });
      })
      .then(function (pair) {
        warmPool.push(pair);
        window.__plotinaNoiseCoreReady = true;
      })
      .catch(function (e) {
        warmError = (e && e.message ? e.message : String(e)) || "unknown";
        warmFailures[id] = (warmFailures[id] || 0) + 1;
        log("warm-up failed (" + id + ")", warmError);
      })
      .then(function () {
        warmInFlight = false;
        warmPromise = null;
        warmTarget = null;
        if (warmPoolCount(id) < WARM_TARGET && backend === id) startWarm(id);
      });
  }

  function warmUp(id, force) {
    if (force !== false) warmFailures[id] = 0;
    startWarm(id);
  }

  /* Take one ready core of the wanted backend and start refilling the pool
     for the selected backend. */
  function takeCore(id) {
    for (var i = 0; i < warmPool.length; i++) {
      if (warmPool[i].id === id) {
        var pair = warmPool.splice(i, 1)[0];
        startWarm(backend);
        return pair.core;
      }
    }
    return null;
  }

  /* Walk the fallback plan looking for a live core; give each candidate the
     same brief warm-up window the original code used (3 s), then move on.
     Returns {id, core} or null — null means raw audio. The decision loop is
     the pure logic.js function; here are only the browser-side ports. */
  function acquireCore(plan) {
    return L.acquireBackendCore(plan, {
      take: takeCore,
      dead: function (id) {
        return !warmInFlight && (warmFailures[id] || 0) >= WARM_MAX_FAILURES;
      },
      kick: function (id) {
        warmUp(id, warmTarget !== id);
      },
      wait: function (id) {
        if (!warmPromise) return Promise.resolve(false);
        return Promise.race([
          warmPromise.then(function () { return true; }, function () { return false; }),
          new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 3000); }),
        ]);
      },
    });
  }

  function drainPool() {
    warmPool.forEach(function (pair) {
      try {
        pair.core.destroy();
      } catch (e) {
        /* nothing else to do */
      }
    });
    warmPool = [];
    window.__plotinaNoiseCoreReady = false;
  }

  function setBackend(value, persist) {
    backend = L.normalizeBackend(value);
    if (persist !== false && !backendOverride) {
      try {
        localStorage.setItem(L.BACKEND_KEY, backend);
      } catch (e) {
        /* private mode */
      }
    }
    // The warm pool holds cores of the previous backend: they would only sit
    // there unused (and keep 25 MB of wasm/model alive), so drop them.
    drainPool();
    warmError = null;
    warmStarted = false;
    stats.requestedBackend = backend;
    syncBackendSelect();
    document.dispatchEvent(new CustomEvent("plotina-noise-backend", { detail: backend }));
    warmUp(backend, true);
  }

  /* Attach an acquired, already-initialised core to the stream. Throws on any
     problem (the core is released), and the caller falls back to raw audio. */
  async function attachWith(id, core, stream, videoTracks) {
    var ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    try {
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
      if (core) {
        try { core.destroy(); } catch (err) {}
      }
      try { ctx.close(); } catch (err) {}
      throw e;
    }
  }

  var md = navigator.mediaDevices;
  if (md && typeof md.getUserMedia === "function") {
    var original = md.getUserMedia.bind(md);
    md.__plotinaOriginal = original;

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

      /* The pre-join mic preview consumes the warm core, and the join request
         arrives milliseconds later. acquireCore waits for the refill per
         backend of the fallback plan (3 s each), and returns null only when
         no model core is coming: then the user gets raw audio, never a
         blocked call. */
      var got = await acquireCore(L.backendPlan(backend));
      if (!got) {
        stats.skipped += 1;
        stats.backend = L.RAW_BACKEND;
        if (stats.last === "request") stats.last = "skipped (no warm-up)";
        return original(constraints);
      }

      return original(L.rawAudioConstraints(constraints)).then(
        function (stream) {
          var video = stream.getVideoTracks();
          return attachWith(got.id, got.core, stream, video).then(
            function (processed) {
              stats.processed += 1;
              stats.backend = L.resolveBackendAfterAttempt(got.id, [got.id]);
              stats.last = "processed ok on " + got.id;
              return processed;
            },
            function (e) {
              stats.failed += 1;
              stats.backend = L.RAW_BACKEND;
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
    range.style.cssText = "flex:1 1 auto;accent-color:var(--cpd-color-text-action-accent,#17795a);";

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

    // Backend selector, one line under the slider: a <select> writing the
    // storage key boot.js reads at load; the warm pool switches in setBackend().
    var beRow = document.createElement("div");
    beRow.setAttribute("data-plotina-backend-row", "");
    beRow.style.cssText = "flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;position:relative;";
    var beLabel = document.createElement("span");
    beLabel.textContent = s.backend + ":";

    // Element's own selects are React/Compound controls; a native <select> draws
    // its popup with the OS palette (white rows, blue selection) and ignores the
    // Element theme. Keep a hidden native select for the existing callers and
    // tests, but drive the visible control with a themed menu.
    var beSelect = document.createElement("select");
    beSelect.id = "plotina-noise-backend";
    beSelect.style.cssText = "display:none;";
    beSelect.setAttribute("aria-label", s.backend);
    L.BACKENDS.forEach(function (id) {
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = L.BACKEND_LABELS[id];
      beSelect.appendChild(opt);
    });
    beSelect.value = backend;
    beSelect.disabled = !!backendOverride;
    beSelect.addEventListener("change", function () {
      setBackend(beSelect.value);
    });

    var beButton = document.createElement("button");
    beButton.type = "button";
    beButton.id = "plotina-noise-backend-button";
    beButton.style.cssText = "display:inline-flex;align-items:center;justify-content:space-between;gap:8px;min-width:88px;padding:3px 8px;border:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.5));border-radius:6px;background:var(--cpd-color-bg-subtle-primary,rgba(128,128,128,.12));color:var(--cpd-color-text-primary,inherit);font:inherit;cursor:pointer;";
    beButton.setAttribute("aria-haspopup", "listbox");
    beButton.setAttribute("aria-expanded", "false");

    var beMenu = document.createElement("div");
    beMenu.id = "plotina-noise-backend-menu";
    beMenu.setAttribute("role", "listbox");
    beMenu.setAttribute("aria-label", s.backend);
    beMenu.style.cssText = "display:none;position:absolute;left:0;top:calc(100% + 4px);z-index:20;min-width:148px;padding:4px;border:1px solid var(--cpd-color-border-interactive-secondary,rgba(128,128,128,.5));border-radius:8px;background:var(--cpd-color-bg-canvas-default,#1b1d22);box-shadow:0 8px 24px rgba(0,0,0,.28);";

    function closeBackendMenu() {
      beMenu.style.display = "none";
      beButton.setAttribute("aria-expanded", "false");
    }

    function renderBackendMenu() {
      beMenu.textContent = "";
      L.BACKENDS.forEach(function (id) {
        var option = document.createElement("button");
        option.type = "button";
        option.setAttribute("role", "option");
        option.setAttribute("data-plotina-backend-option", id);
        option.textContent = L.BACKEND_LABELS[id];
        option.style.cssText = "display:block;width:100%;padding:6px 8px;border:0;border-radius:6px;text-align:left;font:inherit;cursor:pointer;background:transparent;color:var(--cpd-color-text-primary,inherit);";
        option.addEventListener("click", function () {
          setBackend(id);
          beSelect.value = id;
          closeBackendMenu();
          syncBackendSelect();
        });
        beMenu.appendChild(option);
      });
    }

    beButton.addEventListener("click", function (evt) {
      evt.stopPropagation();
      if (beSelect.disabled) return;
      if (beMenu.style.display === "block") {
        closeBackendMenu();
        return;
      }
      renderBackendMenu();
      beMenu.style.display = "block";
      beButton.setAttribute("aria-expanded", "true");
      syncBackendSelect();
    });
    document.addEventListener("mousedown", function (evt) {
      if (!beMenu.isConnected) return;
      if (!beMenu.contains(evt.target) && evt.target !== beButton) closeBackendMenu();
    });

    var beNote = document.createElement("span");
    beNote.setAttribute("data-plotina-backend-note", "");
    beNote.style.cssText = "font-size:12px;opacity:.6;";
    beRow.appendChild(beLabel);
    beRow.appendChild(beButton);
    beRow.appendChild(beMenu);
    beRow.appendChild(beSelect);
    beRow.appendChild(beNote);

    row.appendChild(label);
    row.appendChild(range);
    row.appendChild(value);
    row.appendChild(hint);
    row.appendChild(beRow);
    syncBackendSelect();
    return row;
  }

  /* Keep every live selector in sync (settings may be rebuilt on re-render,
     and the Cinny page / embedded call frame share the same storage key). */
  function syncBackendSelect() {
    var sels = document.querySelectorAll("#plotina-noise-backend");
    for (var i = 0; i < sels.length; i++) {
      if (sels[i].value !== backend) sels[i].value = backend;
      sels[i].disabled = !!backendOverride;
    }
    var lang = document.documentElement.lang || navigator.language;
    var text = backendOverride ? "?plotina-backend=" + backend : (L.strings(lang).backendNote || "");
    var notes = document.querySelectorAll("[data-plotina-backend-note]");
    for (var j = 0; j < notes.length; j++) notes[j].textContent = text;

    var buttons = document.querySelectorAll("#plotina-noise-backend-button");
    for (var k = 0; k < buttons.length; k++) {
      buttons[k].textContent = (L.BACKEND_LABELS[backend] || backend) + " ▾";
      buttons[k].disabled = !!backendOverride;
      buttons[k].setAttribute("aria-label", (L.strings(lang).backend || "Noise suppression") + ": " + (L.BACKEND_LABELS[backend] || backend));
    }
    var options = document.querySelectorAll("[data-plotina-backend-option]");
    for (var m = 0; m < options.length; m++) {
      var selected = options[m].getAttribute("data-plotina-backend-option") === backend;
      options[m].setAttribute("aria-selected", selected ? "true" : "false");
      options[m].style.background = selected ? "var(--cpd-color-bg-action-primary-rest,#17795a)" : "transparent";
      options[m].style.color = selected ? "var(--cpd-color-text-on-solid-primary,#fff)" : "var(--cpd-color-text-primary,inherit)";
    }
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

  warmUp(backend, true);

  /* -------------------------------------------------------------- warm-up */

  var prefetched = {};
  function prefetchAssets() {
    if (prefetched[backend]) return;
    prefetched[backend] = true;
    try {
      loadModule(backend).catch(function () {});
      BACKEND_DEFS[backend].prefetch.forEach(function (url) {
        fetch(url).catch(function () {});
      });
    } catch (e) {
      /* warming up is best-effort */
    }
  }

  /* The Cinny settings page and the embedded Element Call frame share this
     origin and therefore the backend storage key: follow cross-document
     changes live (unless the URL pinned the backend for this page load). */
  window.addEventListener("storage", function (e) {
    if (backendOverride) return;
    if (e.key !== null && e.key !== L.BACKEND_KEY) return;
    var next = L.normalizeBackend(readStoredBackend());
    if (next !== backend) setBackend(next, false);
  });

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
        "backend " + (st.backend || "-") + (st.requestedBackend && st.requestedBackend !== st.backend ? " (fallback from " + st.requestedBackend + ")" : "") + " " + state,
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
    get backend() {
      return backend;
    },
    setBackend: setBackend,
    backends: L.BACKENDS,
    isSupported: function () {
      return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
    },
  };
})();
