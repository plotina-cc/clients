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

  function buildBlock(surface, lang) {
    var s = L.strings(lang);
    var level = readLevel();

    var block = document.createElement("div");
    block.id = BLOCK_ID;
    block.style.cssText = "display:flex;flex-direction:column;gap:4px;";

    var heading = document.createElement("p");
    heading.textContent = s.section || "Sound";
    heading.style.cssText =
      "font-size:12px;font-weight:600;margin:0;color:" + surface.color + ";";

    var row = document.createElement("div");
    row.style.cssText =
      "background:" + surface.background + ";color:" + surface.color + ";padding:12px;";

    var line = document.createElement("div");
    line.style.cssText = "display:flex;align-items:center;gap:12px;";

    var label = document.createElement("span");
    label.textContent = s.title;
    label.style.cssText = "flex:0 0 auto;";

    var range = document.createElement("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.step = "5";
    range.value = String(level);
    range.setAttribute("aria-label", s.title);
    range.style.cssText = "flex:1 1 auto;accent-color:#0f7bff;";

    var value = document.createElement("span");
    value.setAttribute("data-plotina-value", "");
    value.textContent = String(level);
    value.style.cssText = "flex:0 0 3ch;text-align:right;opacity:.8;";

    range.addEventListener("input", function () {
      var next = writeLevel(range.value);
      value.textContent = String(next);
    });

    var hint = document.createElement("div");
    hint.textContent = s.hint;
    hint.style.cssText = "font-size:12px;opacity:.6;margin-top:6px;";

    line.appendChild(label);
    line.appendChild(range);
    line.appendChild(value);
    row.appendChild(line);
    row.appendChild(hint);
    block.appendChild(heading);
    block.appendChild(row);
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
