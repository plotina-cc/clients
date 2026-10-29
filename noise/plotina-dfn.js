/*
 * Plotina: DeepFilterNet3 as a LiveKit track processor (runtime module).
 *
 * Loaded as a plain script by Element Call, so the attach strategy and the level
 * can be changed by replacing this one file on the edge — no Element Call
 * rebuild, no new release. The bundle only calls window.__plotinaAttach(track)
 * from its publish hook.
 *
 * Diagnostics go to POST /noise/report (server-side log). The current state is
 * kept in window.__plotinaDfn for automated tests; nothing is drawn on screen.
 */
(function () {
  "use strict";

  var LEVEL_KEY = "plotina.noise.level";
  var DEFAULT_LEVEL = 70;
  var attached = new WeakSet();
  var session = Math.random().toString(36).slice(2, 10);
  var state = { status: "idle", level: undefined, error: undefined, track: undefined };

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
            build: "dfn.js/4",
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

  function readLevel() {
    try {
      var fromUrl = new URLSearchParams(location.search).get("plotina-level");
      if (fromUrl !== null && fromUrl !== "") return clamp(Number(fromUrl));
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

  window.__plotinaAttach = function (track) {
    var level = readLevel();
    state.level = level;
    if (level === 0) {
      state.status = "skipped";
      return;
    }
    if (!track || typeof track.setProcessor !== "function") {
      state.status = "error";
      state.error = "track has no setProcessor";
      beacon("attach-error");
      return;
    }
    if (attached.has(track)) {
      state.status = "attached";
      return;
    }

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
        beacon("set-processor");
        return track.setProcessor(filter);
      })
      .then(function () {
        settled = true;
        clearTimeout(watchdog);
        attached.add(track);
        state.status = "attached";
        state.track = track.kind || "audio";
        console.info(
          "[plotina] DeepFilterNet3 attached to the microphone track",
          level,
        );
        beacon("attached");
      })
      .catch(function (e) {
        settled = true;
        clearTimeout(watchdog);
        state.status = "error";
        state.error = String((e && e.message) || e).slice(0, 160);
        console.warn("[plotina] DeepFilterNet3 could not attach", e);
        beacon("attach-error");
      });
  };

  beacon("load");
})();
