/*
 * Plotina: DeepFilterNet3 as a LiveKit track processor (runtime module).
 *
 * Loaded as a plain script by Element Call, so the attach strategy and the level
 * can be changed by replacing this one file on the edge — no Element Call
 * rebuild, no new release. The bundle only calls window.__plotinaAttach(track)
 * from its publish hook.
 *
 * Diagnostics go to POST /noise/report (server-side log). The current state is
 * kept in window.__plotinaDfn for automated tests; this file draws nothing —
 * the in-call level control lives in plotina-panel.js and only calls
 * window.__plotinaSetLevel() here.
 */
(function () {
  "use strict";

  var LEVEL_KEY = "plotina.noise.level";
  var DEFAULT_LEVEL = 40;
  var attached = new WeakSet();
  var pending = new WeakSet();
  var session = Math.random().toString(36).slice(2, 10);
  // The level, the track and the processor are one piece of state: the panel
  // changes the level while a call is running, and attach() has to know both
  // what is already processed and what value is current.
  var current = { track: null, processor: null };
  // Set once the user moves the panel's slider. From then on the URL is a
  // starting value, not an override: re-attaching a track (device change, mic
  // toggled off and on) must keep the level the user chose.
  var explicit = false;
  var state = {
    status: "idle",
    level: undefined,
    applied: undefined,
    bypass: undefined,
    error: undefined,
    track: undefined,
  };

  window.__plotinaDfn = state;

  function beacon(kind, extra) {
    try {
      var body = JSON.stringify(
        Object.assign(
          {
            kind: kind,
            status: state.status,
            level: state.level,
            error: state.error,
            page: location.pathname,
            session: session,
            build: "dfn.js/5",
          },
          extra || {},
        ),
      );
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/noise/report", body);
      } else {
        fetch("/noise/report", { method: "POST", body: body, keepalive: true });
      }
    } catch (e) {
      /* reporting must never break the call */
    }
  }

  function clamp(value) {
    if (!isFinite(value)) return DEFAULT_LEVEL;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  /* Element Call runs as a Matrix widget, and the widget API puts its
     parameters in the fragment: #?widgetId=…&parentUrl=…&plotina-level=30.
     A plain link or the call's own query string can still carry the value, so
     both are read, search first. Storage is the fallback. */
  function readLevel() {
    try {
      if (!explicit) {
        var fromSearch = new URLSearchParams(location.search).get("plotina-level");
        if (fromSearch !== null && fromSearch !== "") return clamp(Number(fromSearch));
        var hash = location.hash || "";
        var mark = hash.indexOf("?");
        if (mark !== -1) {
          var fromHash = new URLSearchParams(hash.slice(mark + 1)).get("plotina-level");
          if (fromHash !== null && fromHash !== "") return clamp(Number(fromHash));
        }
      }
      var stored = localStorage.getItem(LEVEL_KEY);
      if (stored !== null && stored !== "") return clamp(Number(stored));
    } catch (e) {
      /* storage can be blocked */
    }
    return DEFAULT_LEVEL;
  }

  function base() {
    // Absolute, not relative to the page: Element Call opens /room/ with a
    // trailing slash, and new URL("noise/", ...) resolved to /room/noise/.
    return location.origin + "/noise";
  }

  function wrapAssetFetch() {
    if (window.__plotinaFetchWrapped) return;
    window.__plotinaFetchWrapped = true;
    var orig = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.indexOf("/noise/dfn/") === -1) return orig.apply(this, arguments);
      var name = url.split("/").pop();
      var t0 = Date.now();
      beacon("fetch-start", { event: name });
      return orig.apply(this, arguments).then(
        function (res) {
          beacon("fetch-done", {
            event: name + ":" + res.status + ":" + (Date.now() - t0) + "ms",
          });
          return res;
        },
        function (err) {
          beacon("fetch-error", {
            event: name + ":" + String((err && err.message) || err),
          });
          throw err;
        },
      );
    };
  }

  window.__plotinaReport = function (kind, extra) {
    beacon(kind, extra || {});
  };

  window.__plotinaEvent = function (source, hasTrack) {
    state.status = "attaching";
    state.error = undefined;
    state.track = "event " + source + (hasTrack ? " (track)" : " (no track)");
    beacon("event", { event: source + (hasTrack ? ":track" : ":no-track") });
  };

  /* Apply a level to the processor that is attached right now. 0 is genuine
     bypass: the worklet's atten_lim of 0 dB passes the signal through, and
     setEnabled(false) also skips its work. Measured on this build: 1 dB → −1 dB
     of noise, 70 → −70 dB, 100 → silence. */
  function applyLevel(level) {
    var processor = current.processor;
    if (!processor) return false;
    state.applied = level;
    state.bypass = level === 0;
    try {
      if (typeof processor.setEnabled === "function") {
        var done = processor.setEnabled(level > 0);
        if (done && typeof done.catch === "function") done.catch(function () {});
      }
      if (level > 0 && typeof processor.setSuppressionLevel === "function") {
        processor.setSuppressionLevel(level);
      }
      return true;
    } catch (e) {
      beacon("apply-error", { event: String((e && e.message) || e).slice(0, 120) });
      return false;
    }
  }

  function attach(track, level) {
    state.level = level;
    if (level === 0) {
      // Remember the track: turning the panel up later must attach to it.
      if (track) current.track = track;
      state.status = "skipped";
      state.bypass = true;
      beacon("skip-zero");
      return;
    }
    if (!track || typeof track.setProcessor !== "function") {
      state.status = "error";
      state.error = "track has no setProcessor";
      beacon("attach-error");
      return;
    }
    current.track = track;
    if (attached.has(track)) {
      state.status = "attached";
      return;
    }
    if (pending.has(track)) {
      state.status = "attaching";
      return;
    }
    pending.add(track);

    state.status = "attaching";
    beacon("attach-start");

    var root = base();
    wrapAssetFetch();
    var settled = false;
    var watchdog = setTimeout(function () {
      if (settled) return;
      state.status = "error";
      state.error = "timeout 45s in setProcessor";
      beacon("attach-timeout");
    }, 45000);

    import(root + "/vendor/dfn.esm.js")
      .then(function (mod) {
        beacon("module-imported");
        var Processor = mod.DeepFilterNoiseFilterProcessor;
        if (!Processor) throw new Error("processor class missing");
        var filter = new Processor({
          sampleRate: 48000,
          noiseReductionLevel: level,
          enabled: true,
          assetConfig: { cdnUrl: root + "/dfn" },
        });
        // Published before setProcessor resolves, so a level change while the
        // 24 MB of assets are loading still reaches the node once it exists.
        current.processor = filter;
        beacon("set-processor");
        return track.setProcessor(filter);
      })
      .then(function () {
        settled = true;
        clearTimeout(watchdog);
        pending.delete(track);
        attached.add(track);
        state.status = "attached";
        state.track = track.kind || "audio";
        state.error = undefined;
        // The panel may have moved the slider while the module was loading.
        if (state.level !== level) applyLevel(state.level);
        else {
          state.applied = level;
          state.bypass = false;
        }
        console.info(
          "[plotina] DeepFilterNet3 attached to the microphone track",
          state.level,
        );
        beacon("attached");
      })
      .catch(function (e) {
        settled = true;
        clearTimeout(watchdog);
        pending.delete(track);
        current.processor = null;
        state.status = "error";
        state.error = String((e && e.message) || e).slice(0, 160);
        console.warn("[plotina] DeepFilterNet3 could not attach", e);
        beacon("attach-error");
      });
  }

  window.__plotinaAttach = function (track) {
    attach(track, readLevel());
  };

  /* The panel's only entry point. It never touches the track graph: the level
     goes to the worklet over postMessage, so the call keeps running. A value
     raised from 0 also attaches to the remembered track — the processor was
     deliberately skipped when the call started with the slider at zero. */
  window.__plotinaSetLevel = function (value, options) {
    var opts = options || {};
    var level = clamp(Number(value));
    explicit = true;
    state.level = level;
    var live = applyLevel(level);
    state.applied = level;
    state.bypass = level === 0;
    if (opts.persist !== false) {
      try {
        localStorage.setItem(LEVEL_KEY, String(level));
      } catch (e) {
        /* private mode */
      }
    }
    if (opts.report !== false) {
      beacon("level-set", { applied: live ? "live" : "stored" });
    }
    if (!live && level > 0 && current.track && !attached.has(current.track)) {
      attach(current.track, level);
    }
    return level;
  };

  beacon("load");
})();
