/*
 * Plotina: DeepFilterNet3 as a LiveKit track processor (runtime module).
 *
 * Loaded as a plain script by Element Call, so the attach strategy, the level
 * and the badge can be changed by replacing this one file on the edge — no
 * Element Call rebuild, no new release. The bundle only calls
 * window.__plotinaAttach(track) from its publish hook.
 */
(function () {
  "use strict";

  var LEVEL_KEY = "plotina.noise.level";
  var DEFAULT_LEVEL = 70;
  var attached = new WeakSet();
  var state = { status: "idle", level: undefined, error: undefined, track: undefined };

  window.__plotinaDfn = state;

  function debug() {
    try {
      return new URLSearchParams(location.search).get("plotina-debug") === "1";
    } catch (e) {
      return false;
    }
  }

  function renderBadge() {
    if (!debug()) return;
    try {
      var badge = document.getElementById("plotina-dfn-badge");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "plotina-dfn-badge";
        badge.style.cssText = [
          "position:fixed",
          "left:8px",
          "bottom:8px",
          "z-index:2147483647",
          "background:rgba(0,0,0,.78)",
          "color:#fff",
          "font:12px/1.35 monospace",
          "padding:6px 8px",
          "border-radius:6px",
          "pointer-events:none",
          "white-space:pre-wrap",
          "overflow-wrap:anywhere",
          "max-width:min(92vw, 560px)",
        ].join(";");
        document.documentElement.appendChild(badge);
      }
      badge.textContent = [
        "DFN " + state.status,
        "level " + (state.level === undefined ? "-" : state.level),
        state.track ? "track " + state.track : "",
        state.error ? "error " + state.error : "",
      ]
        .filter(Boolean)
        .join("\n");
    } catch (e) {
      /* diagnostics only */
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
    return new URL("noise/", location.href).href.replace(/\/$/, "");
  }

  window.__plotinaEvent = function (source, hasTrack) {
    state.status = "attaching";
    state.error = undefined;
    state.track = "event " + source + (hasTrack ? " (track)" : " (no track)");
    renderBadge();
  };

  window.__plotinaAttach = function (track) {
    var level = readLevel();
    state.level = level;
    if (level === 0) {
      state.status = "skipped";
      renderBadge();
      return;
    }
    if (!track || typeof track.setProcessor !== "function") {
      state.status = "error";
      state.error = "track has no setProcessor";
      renderBadge();
      return;
    }
    if (attached.has(track)) {
      state.status = "attached";
      renderBadge();
      return;
    }

    state.status = "attaching";
    renderBadge();

    var root = base();
    import(root + "/vendor/dfn.esm.js")
      .then(function (mod) {
        var Processor = mod.DeepFilterNoiseFilterProcessor;
        if (!Processor) throw new Error("processor class missing");
        var filter = new Processor({
          sampleRate: 48000,
          noiseReductionLevel: level,
          enabled: true,
          assetConfig: { cdnUrl: root + "/dfn" },
        });
        return track.setProcessor(filter);
      })
      .then(function () {
        attached.add(track);
        state.status = "attached";
        state.track = track.kind || "audio";
        renderBadge();
        console.info("[plotina] DeepFilterNet3 attached to the microphone track", level);
      })
      .catch(function (e) {
        state.status = "error";
        state.error = String((e && e.message) || e).slice(0, 160);
        renderBadge();
        console.warn("[plotina] DeepFilterNet3 could not attach", e);
      });
  };

  setTimeout(renderBadge, 0);
})();
