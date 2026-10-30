/*
 * Plotina: noise-suppression level panel for Element Call.
 *
 * Element Call v0.26.1 has no UI for the level; the only control it ships is a
 * boolean noiseSuppression in the developer tab, which is not ours. This file
 * draws a small floating control inside the call view: a pill with the current
 * value, and a 0–100 dB slider. It only calls window.__plotinaSetLevel() from
 * plotina-dfn.js, so the value is applied to the running LiveKit track
 * processor without touching the call.
 *
 * When it is shown:
 *   - only inside a call (/room), never on the sign-in or lobby shell;
 *   - when the page is embedded (window.self !== window.top), which is how
 *     Element Web, Cinny and any widget host open Element Call; or
 *   - when the user agent is Element X's WebView (it sets its own UA string,
 *     "Element X/<version> (…; Android …)", instead of a Mozilla one).
 * A top-level desktop browser tab at call.plotina.cc stays clean; ?plotina-panel=1
 * or =0 overrides the decision for testing and support.
 *
 * The panel owns no audio state: plotina-dfn.js is the single source of truth
 * for the level, and stores it under the same localStorage key the settings
 * sliders in Element Web and Cinny use.
 */
(function () {
  "use strict";

  if (window.__plotinaEc !== true || window.__plotinaPanelLoaded) return;
  window.__plotinaPanelLoaded = true;

  var LEVEL_KEY = "plotina.noise.level";
  var DEFAULT_LEVEL = 40;

  function clamp(value) {
    var n = Number(value);
    if (!isFinite(n)) return DEFAULT_LEVEL;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  /* Widget parameters arrive in the fragment (#?widgetId=…&plotina-level=30),
     because that is where the Matrix widget API puts them; a plain link can
     still use the query string. Keep the order in step with readLevel() in
     plotina-dfn.js: search first, then hash, then storage. */
  function fromUrl(name) {
    try {
      var v = new URLSearchParams(location.search).get(name);
      if (v !== null && v !== "") return v;
      var hash = location.hash || "";
      var q = hash.indexOf("?");
      if (q !== -1) {
        v = new URLSearchParams(hash.slice(q + 1)).get(name);
        if (v !== null && v !== "") return v;
      }
    } catch (e) {
      /* malformed URL */
    }
    return null;
  }

  /* ------------------------------------------------------------- gating */

  var forced = fromUrl("plotina-panel");
  var ua = navigator.userAgent || "";
  var android = /Android/i.test(ua);
  // Element X sets its own UA ("Element X/<version> (…; Android …)"), which is
  // how it is told apart from a desktop browser. If a WebView build reports the
  // stock Mozilla UA instead, the widget parameters in the fragment still say
  // that this is an app host, not a browser tab.
  var widget = /[#?&]widgetId=/.test(location.hash || "");
  var elementX = android && (widget || !/^Mozilla\//i.test(ua));
  var embedded = true;
  try {
    embedded = window.self !== window.top;
  } catch (e) {
    /* cross-origin parent still means embedded */
  }
  var enabled =
    forced === "1" || (forced !== "0" && (embedded || elementX));

  if (!enabled) return;
  if (!/^\/room(?:\/|$)/.test(location.pathname)) return;

  /* --------------------------------------------------------------- text */

  var LANG = (navigator.language || document.documentElement.lang || "").toLowerCase();
  var RU = LANG.indexOf("ru") === 0;
  var S = RU
    ? {
        title: "Шумоподавление",
        pill: "Шумодав",
        unit: "дБ",
        off: "выкл",
        hint: "0 — выключено, 100 — максимум",
      }
    : {
        title: "Noise suppression",
        pill: "Noise",
        unit: "dB",
        off: "off",
        hint: "0 disables it, 100 is the maximum",
      };

  function format(level) {
    return level === 0 ? S.off : level + " " + S.unit;
  }

  /* -------------------------------------------------------------- level */

  function storedLevel() {
    var state = window.__plotinaDfn;
    if (state && typeof state.level === "number") return clamp(state.level);
    var fromQuery = fromUrl("plotina-level");
    if (fromQuery !== null) return clamp(fromQuery);
    try {
      var raw = localStorage.getItem(LEVEL_KEY);
      if (raw !== null && raw !== "") return clamp(raw);
    } catch (e) {
      /* private mode */
    }
    return DEFAULT_LEVEL;
  }

  function applyLevel(level, final) {
    if (typeof window.__plotinaSetLevel === "function") {
      return clamp(
        window.__plotinaSetLevel(level, { persist: !!final, report: !!final }),
      );
    }
    try {
      if (final) localStorage.setItem(LEVEL_KEY, String(level));
    } catch (e) {
      /* private mode */
    }
    document.dispatchEvent(
      new CustomEvent("plotina-noise-level", { detail: level }),
    );
    return level;
  }

  /* --------------------------------------------------------------- theme */

  function theme() {
    var fallback =
      window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    var nodes = [document.body, document.documentElement];
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i]) continue;
      var bg = "";
      try {
        bg = getComputedStyle(nodes[i]).backgroundColor;
      } catch (e) {
        continue;
      }
      var m = /rgba?\(([^)]+)\)/.exec(bg || "");
      if (!m) continue;
      var p = m[1].split(",").map(function (x) {
        return parseFloat(x);
      });
      if (p.length < 3 || p.some(isNaN)) continue;
      if (p.length > 3 && p[3] === 0) continue;
      return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255 < 0.5
        ? "dark"
        : "light";
    }
    return fallback;
  }

  /* ----------------------------------------------------------------- dom */

  var host = document.createElement("div");
  host.id = "plotina-noise-panel";

  var style = document.createElement("style");
  style.id = "plotina-noise-style";
  style.textContent = [
    "#plotina-noise-panel{position:fixed;right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(140px + env(safe-area-inset-bottom,0px));z-index:900;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:13px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--pp-fg);-webkit-tap-highlight-color:transparent;touch-action:manipulation}",
    "#plotina-noise-panel[hidden]{display:none}",
    "#plotina-noise-panel[data-theme=dark]{--pp-bg:rgba(28,28,32,.96);--pp-fg:#f2f2f2;--pp-border:rgba(255,255,255,.18);--pp-muted:rgba(255,255,255,.62);--pp-accent:#3ccf9a;--pp-track:rgba(255,255,255,.22)}",
    "#plotina-noise-panel[data-theme=light]{--pp-bg:rgba(255,255,255,.97);--pp-fg:#1b1b1b;--pp-border:rgba(0,0,0,.14);--pp-muted:rgba(0,0,0,.55);--pp-accent:#17795a;--pp-track:rgba(0,0,0,.16)}",
    "#plotina-noise-panel .pp-pill{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:18px;border:1px solid var(--pp-border);background:var(--pp-bg);color:var(--pp-fg);box-shadow:0 2px 10px rgba(0,0,0,.28);font:inherit;cursor:pointer;white-space:nowrap}",
    "#plotina-noise-panel .pp-pill:focus-visible{outline:2px solid var(--pp-accent);outline-offset:2px}",
    "#plotina-noise-panel .pp-dot{width:8px;height:8px;border-radius:50%;background:var(--pp-accent);flex:0 0 auto}",
    "#plotina-noise-panel .pp-card{width:244px;max-width:calc(100vw - 24px);box-sizing:border-box;padding:10px 12px 9px;border:1px solid var(--pp-border);border-radius:12px;background:var(--pp-bg);box-shadow:0 10px 28px rgba(0,0,0,.32);color:var(--pp-fg)}",
    "#plotina-noise-panel .pp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600;margin-bottom:8px}",
    "#plotina-noise-panel .pp-value{font-variant-numeric:tabular-nums;font-weight:400;opacity:.75}",
    "#plotina-noise-panel input[type=range]{-webkit-appearance:none;appearance:none;display:block;width:100%;height:22px;margin:0;background:transparent;cursor:pointer}",
    "#plotina-noise-panel input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:var(--pp-track)}",
    "#plotina-noise-panel input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:18px;margin-top:-6px;border-radius:50%;background:#fff;border:none;box-shadow:0 1px 4px rgba(0,0,0,.45)}",
    "#plotina-noise-panel input[type=range]::-moz-range-track{height:6px;border-radius:3px;background:var(--pp-track)}",
    "#plotina-noise-panel input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#fff;border:none;box-shadow:0 1px 4px rgba(0,0,0,.45)}",
    "#plotina-noise-panel input[type=range]:focus-visible{outline:2px solid var(--pp-accent);outline-offset:2px;border-radius:4px}",
    "#plotina-noise-panel .pp-hint{margin-top:2px;font-size:11px;color:var(--pp-muted)}",
  ].join("\n");

  var pill = document.createElement("button");
  pill.type = "button";
  pill.className = "pp-pill";
  pill.setAttribute("aria-expanded", "false");
  pill.setAttribute("aria-controls", "plotina-noise-card");

  var dot = document.createElement("span");
  dot.className = "pp-dot";
  var pillText = document.createElement("span");
  pillText.className = "pp-label";
  pill.appendChild(dot);
  pill.appendChild(pillText);

  var card = document.createElement("div");
  card.className = "pp-card";
  card.id = "plotina-noise-card";
  card.hidden = true;

  var head = document.createElement("div");
  head.className = "pp-head";
  var title = document.createElement("span");
  title.textContent = S.title;
  var value = document.createElement("span");
  value.className = "pp-value";
  head.appendChild(title);
  head.appendChild(value);

  var range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.step = "5";
  range.setAttribute("aria-label", S.title);

  var hint = document.createElement("div");
  hint.className = "pp-hint";
  hint.textContent = S.hint;

  card.appendChild(head);
  card.appendChild(range);
  card.appendChild(hint);
  host.appendChild(card);
  host.appendChild(pill);
  host.appendChild(style);

  /* -------------------------------------------------------------- events */

  var open = false;
  var level = storedLevel();
  var dragTimer = null;
  var dragging = false;

  function render(paintRange) {
    if (paintRange) range.value = String(level);
    value.textContent = format(level);
    pillText.textContent = S.pill + " · " + format(level);
    pill.setAttribute("aria-label", S.pill + ": " + format(level));
  }

  function setOpen(next) {
    open = next;
    card.hidden = !open;
    pill.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      host.dataset.theme = theme();
      level = storedLevel();
      render(true);
    }
  }

  pill.addEventListener("click", function (event) {
    event.stopPropagation();
    setOpen(!open);
  });

  range.addEventListener("input", function () {
    level = clamp(range.value);
    dragging = true;
    value.textContent = format(level);
    pillText.textContent = S.pill + " · " + format(level);
    /* Live during the drag: no storage write, no beacon per pixel. The
       processor's postMessage is cheap, but a 60 ms gate keeps the log and
       localStorage quiet while still feeling instant. */
    if (dragTimer) clearTimeout(dragTimer);
    dragTimer = setTimeout(function () {
      dragTimer = null;
      applyLevel(level, false);
    }, 60);
  });

  range.addEventListener("change", function () {
    level = clamp(range.value);
    dragging = false;
    if (dragTimer) {
      clearTimeout(dragTimer);
      dragTimer = null;
    }
    applyLevel(level, true);
    render(true);
  });

  host.addEventListener("keydown", function (event) {
    event.stopPropagation();
    if (event.key === "Escape") setOpen(false);
  });
  host.addEventListener("pointerdown", function (event) {
    event.stopPropagation();
  });

  document.addEventListener("keydown", function (event) {
    if (open && event.key === "Escape") setOpen(false);
  });

  /* ---------------------------------------------------------------- mount */

  function inRoom() {
    return /^\/room(?:\/|$)/.test(location.pathname);
  }

  function mount() {
    if (!document.body) return;
    if (!host.isConnected) document.body.appendChild(host);
    if (!style.isConnected) document.head.appendChild(style);
    host.dataset.theme = theme();
    host.hidden = !inRoom();
    render(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }

  /* The room view re-renders on its own schedule; a removed node is cheap to
     put back, and the level may change under us (attach reads the hash). */
  setInterval(function () {
    if (!document.body) return;
    if (!host.isConnected) {
      document.body.appendChild(host);
    }
    host.hidden = !inRoom();
    host.dataset.theme = theme();
    if (!open && !dragging) {
      var next = storedLevel();
      if (next !== level) {
        level = next;
        render(true);
      }
    }
  }, 2000);
})();
