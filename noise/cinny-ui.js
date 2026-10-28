/*
 * Plotina noise suppression — Cinny Web settings block.
 *
 * Cinny does not use Element Web's markup, so the slider gets its own small
 * section at the top of Settings -> General. The audio itself is handled inside
 * Cinny's embedded Element Call document (see noise/boot.js), which shares the
 * same origin and therefore the same localStorage key.
 */
(function (global) {
  "use strict";

  var L = global.PlotinaNoiseLogic;
  if (!L) {
    console.info("[plotina-noise] logic.js is missing; Cinny slider stays disabled");
    return;
  }

  var BLOCK_ID = "plotina-noise-cinny";

  function readLevel() {
    try {
      return L.clampLevel(localStorage.getItem(L.LEVEL_KEY));
    } catch (e) {
      return L.DEFAULT_LEVEL;
    }
  }

  function writeLevel(value) {
    var level = L.clampLevel(value);
    try {
      localStorage.setItem(L.LEVEL_KEY, String(level));
    } catch (e) {
      /* private mode */
    }
    return level;
  }

  function findAnchor() {
    var paragraphs = document.querySelectorAll("p, span, div");
    for (var i = 0; i < paragraphs.length; i++) {
      var el = paragraphs[i];
      if (el.children.length !== 0) continue;
      var text = (el.textContent || "").trim();
      if (text === "Appearance") return el;
    }
    return null;
  }

  /* Copy the surface colour from a real settings row so the block follows the
     light/dark theme without hardcoding either. */
  function sampleSurface(section) {
    var fallback = { background: "rgb(242, 242, 242)", color: "rgb(0, 0, 0)" };
    if (!section) return fallback;
    var rows = section.querySelectorAll("div");
    for (var i = 0; i < rows.length; i++) {
      var cs = getComputedStyle(rows[i]);
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") {
        return { background: cs.backgroundColor, color: cs.color };
      }
    }
    return fallback;
  }

  /* Cinny paints its rows with the theme's own colours; we cannot use its CSS
     modules, so the shape of the block is rebuilt by hand and matched to the
     surrounding sections: a heading outside, a rounded card, a title row, a
     full width slider. */

  function sampleAccent() {
    var vars = [
      "--mui-palette-primary-main",
      "--accent",
      "--primary-color",
      "--cpd-color-accent",
    ];
    try {
      var cs = getComputedStyle(document.documentElement);
      for (var i = 0; i < vars.length; i++) {
        var v = cs.getPropertyValue(vars[i]).trim();
        if (v) return v;
      }
    } catch (e) {
      /* no computed styles */
    }
    return "#8b7cf6";
  }

  function isDarkSurface(rgb) {
    var m = /rgba?\(([^)]+)\)/.exec(rgb || "");
    if (!m) return true;
    var p = m[1].split(",").map(function (x) { return parseFloat(x); });
    if (p.length < 3 || p.some(isNaN)) return true;
    return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255 < 0.5;
  }

  function ensureSliderStyles(accent) {
    var id = "plotina-noise-style";
    var old = document.getElementById(id);
    if (old) old.parentNode.removeChild(old);
    var st = document.createElement("style");
    st.id = id;
    st.textContent = [
      "#" + BLOCK_ID + " input[type=range]{-webkit-appearance:none;appearance:none;" +
        "width:100%;height:6px;border-radius:3px;outline:none;margin:0;cursor:pointer;}",
      "#" + BLOCK_ID + " input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;" +
        "appearance:none;width:18px;height:18px;border-radius:50%;background:#fff;" +
        "border:none;box-shadow:0 1px 4px rgba(0,0,0,.45);cursor:pointer;}",
      "#" + BLOCK_ID + " input[type=range]::-moz-range-thumb{width:18px;height:18px;" +
        "border-radius:50%;background:#fff;border:none;" +
        "box-shadow:0 1px 4px rgba(0,0,0,.45);cursor:pointer;}",
      "#" + BLOCK_ID + " input[type=range]::-moz-range-track{height:6px;" +
        "border-radius:3px;background:transparent;}",
      "#" + BLOCK_ID + " input[type=range]:focus-visible{box-shadow:0 0 0 2px " + accent + "66;}",
    ].join("\n");
    document.head.appendChild(st);
  }

  function paintTrack(range, level, accent, track) {
    var pct = Math.max(0, Math.min(100, level));
    range.style.background =
      "linear-gradient(to right, " + accent + " 0 " + pct + "%, " + track + " " + pct + "% 100%)";
  }

  function buildBlock(surface, lang) {
    var s = L.strings(lang);
    var level = readLevel();
    var accent = sampleAccent();
    var track = isDarkSurface(surface.background)
      ? "rgba(255,255,255,0.18)"
      : "rgba(0,0,0,0.12)";

    ensureSliderStyles(accent);

    var block = document.createElement("div");
    block.id = BLOCK_ID;
    block.style.cssText = "display:flex;flex-direction:column;margin:0 0 16px;";

    var heading = document.createElement("p");
    heading.textContent = s.section || "Sound";
    heading.style.cssText =
      "font-size:16px;font-weight:600;line-height:1.3;margin:0 0 10px;color:" +
      surface.color + ";";

    var card = document.createElement("div");
    card.style.cssText =
      "background:" + surface.background + ";color:" + surface.color +
      ";border-radius:12px;padding:16px;";

    var titleRow = document.createElement("div");
    titleRow.style.cssText =
      "display:flex;align-items:baseline;gap:12px;margin:0 0 12px;";

    var label = document.createElement("span");
    label.textContent = s.title;
    label.style.cssText = "flex:1 1 auto;min-width:0;font-size:16px;line-height:1.35;";

    var value = document.createElement("span");
    value.setAttribute("data-plotina-value", "");
    value.textContent = String(level);
    value.style.cssText =
      "flex:0 0 auto;font-size:16px;line-height:1.35;opacity:.75;" +
      "font-variant-numeric:tabular-nums;";

    var range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.step = "5";
    range.value = String(level);
    range.setAttribute("aria-label", s.title);
    paintTrack(range, level, accent, track);

    var hint = document.createElement("div");
    hint.textContent = s.hint;
    hint.style.cssText = "font-size:12px;opacity:.6;margin-top:12px;";

    range.addEventListener("input", function () {
      var next = writeLevel(range.value);
      value.textContent = String(next);
      paintTrack(range, next, accent, track);
      // Write to storage alone only affects the next getUserMedia. boot.js keeps
      // the running processors and can retune them, so hand the value over and
      // let a call in progress change without redialling.
      try {
        var api = global.__plotinaNoise;
        if (api && typeof api.setLevel === "function") api.setLevel(next);
      } catch (e) {
        /* no wrapper on this page */
      }
    });

    titleRow.appendChild(label);
    titleRow.appendChild(value);
    card.appendChild(titleRow);
    card.appendChild(range);
    card.appendChild(hint);
    block.appendChild(heading);
    block.appendChild(card);
    return block;
  }

  function inject() {
    var existing = document.getElementById(BLOCK_ID);
    if (existing && existing.isConnected) return existing;

    var anchor = findAnchor();
    if (!anchor) return null;

    var section = anchor.parentElement;
    if (!section || !section.parentElement) return null;

    var block = buildBlock(sampleSurface(section), document.documentElement.lang || navigator.language);
    section.parentElement.insertBefore(block, section);
    return block;
  }

  var observer = null;

  function start() {
    if (observer) return;
    observer = new MutationObserver(function () {
      if (document.getElementById(BLOCK_ID)) return;
      try {
        inject();
      } catch (e) {
        console.info("[plotina-noise] Cinny injection failed", e);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    try {
      inject();
    } catch (e) {
      console.info("[plotina-noise] Cinny injection failed", e);
    }
  }

  function reset() {
    var block = document.getElementById(BLOCK_ID);
    if (block) block.remove();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  global.PlotinaNoiseCinny = { inject: inject, reset: reset, BLOCK_ID: BLOCK_ID };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})(window);
