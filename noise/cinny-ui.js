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

  // Desktop shell (Tauri) only: the webview serves the app from
  // http://localhost:<port>, so a plain <a href="https://plotina.cc"> click
  // tries to navigate that webview and the system browser never opens.
  // Upstream only forwards target=_blank windows through on_new_window, so
  // route external links through window.open; on the web this branch is dead
  // and links keep their normal navigation.
  if (global.__TAURI_INTERNALS__) {
    document.addEventListener(
      "click",
      function (event) {
        var node = event.target;
        while (node && node.tagName !== "A") node = node.parentNode;
        if (!node || !node.href) return;
        if (node.origin === global.location.origin) return;
        event.preventDefault();
        global.open(node.href, "_blank");
      },
      true,
    );
  }

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

  function readBackend() {
    try {
      return L.resolveBackend({ stored: localStorage.getItem(L.BACKEND_KEY), search: "" });
    } catch (e) {
      return L.DEFAULT_BACKEND;
    }
  }

  function writeBackend(value) {
    var name = L.normalizeBackend(value);
    try {
      localStorage.setItem(L.BACKEND_KEY, name);
    } catch (e) {
      /* private mode */
    }
    // If a call frame shares this document (Cinny embeds Element Call), try
    // the wrapper API first; otherwise the frame picks it up via "storage".
    try {
      var api = global.__plotinaNoise;
      if (api && typeof api.setBackend === "function") api.setBackend(name);
    } catch (e) {
      /* no wrapper on this page */
    }
    syncBackendSelects();
    return name;
  }

  function syncBackendSelects() {
    var sel = document.querySelector("[data-plotina-backend]");
    if (sel && sel.value !== readBackend()) sel.value = readBackend();
  }

  if (L.BACKEND_KEY) {
    global.addEventListener("storage", function (e) {
      if (e.key === null || e.key === L.BACKEND_KEY) syncBackendSelects();
    });
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

  /* ---------------------------------------------------------------- channel
   * Lite Desktop (Electron) only: a "Канал обновлений" block directly under
   * the noise card, driven by the preload bridge (window.plotinaLite.updater
   * .channel). On Cinny Web the bridge does not exist and the block is never
   * built, so the settings page stays untouched there. All policy (dev
   * acknowledgement, downgrade rules) lives in the main process; this only
   * renders state and forwards the user's choice. The select is native like
   * the backend picker — layout properties only, no appearance overrides. */
  var CHANNEL_TEXT = {
    channelLabel: "Канал обновлений",
    stableLabel: "Стабильный",
    devLabel: "Dev",
    devWarningMessage: "Включить Dev-канал обновлений?",
    devWarningDetail:
      "Dev-канал получает тестовые сборки с GitHub-релиза dev-latest. " +
      "Они не проходят ту же проверку, что стабильные, могут откатываться и " +
      "меняться без предупреждения. Возврат на стабильный канал — отдельное " +
      "действие, оно может установить версию ниже текущей.",
    checkForUpdates: "Проверить обновления",
  };

  function channelBridge() {
    var lite = global.plotinaLite;
    var up = lite && lite.updater;
    var ch = up && up.channel;
    if (!ch || typeof ch.get !== "function" || typeof ch.set !== "function") return null;
    return up;
  }

  function errText(e) {
    return String((e && e.message) || e || "неизвестная ошибка");
  }

  function channelStatusText(st) {
    if (!st || !st.state) return "";
    switch (st.state) {
      case "checking":
        return "Проверяю обновления…";
      case "available":
        return "Доступно обновление: " + st.version + (st.downgrade ? " (понижение версии)" : "");
      case "downloaded":
        return "Скачано: " + st.version + " — перезапустите приложение для установки";
      case "up-to-date":
        return "Обновлений нет" + (st.version ? " (" + st.version + ")" : "");
      case "channel":
        return (
          CHANNEL_TEXT.channelLabel +
          ": " +
          (st.channel === "dev" ? CHANNEL_TEXT.devLabel : CHANNEL_TEXT.stableLabel)
        );
      case "channel-confirmation-required":
        return "Для Dev-канала требуется подтверждение — выберите его ещё раз";
      case "no-feed":
        return "Лента обновлений недоступна";
      case "not-packaged":
        return "Обновления недоступны в этой сборке";
      case "manual-required":
        return st.message || "Обновления управляются вручную";
      case "error":
        return "Ошибка: " + (st.message || "неизвестно");
      default:
        return "";
    }
  }

  var channelStatusUnsub = null;

  function subscribeChannelStatus() {
    if (channelStatusUnsub) return;
    var lite = global.plotinaLite;
    if (!lite || !lite.updater || typeof lite.updater.onStatus !== "function") return;
    try {
      channelStatusUnsub = lite.updater.onStatus(function (st) {
        // One live subscription for the whole page: address the current block,
        // so settings re-renders cannot stack listeners or hit detached nodes.
        var el = document.querySelector("[data-plotina-channel-status]");
        if (!el || !el.isConnected) return;
        var msg = channelStatusText(st);
        if (msg) el.textContent = msg;
      });
    } catch (e) {
      channelStatusUnsub = null;
    }
  }

  function buildChannelBlock(surface) {
    var up = channelBridge();
    if (!up) return null;

    var block = document.createElement("div");
    block.setAttribute("data-plotina-channel-block", "");
    block.style.cssText = "display:flex;flex-direction:column;margin:0 0 16px;";

    var heading = document.createElement("p");
    heading.textContent = CHANNEL_TEXT.channelLabel;
    heading.style.cssText =
      "font-size:16px;font-weight:600;line-height:1.3;margin:0 0 10px;color:" +
      surface.color + ";";

    var card = document.createElement("div");
    card.style.cssText =
      "background:" + surface.background + ";color:" + surface.color +
      ";border-radius:12px;padding:16px;";

    var row = document.createElement("div");
    row.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;";

    var label = document.createElement("span");
    label.textContent = CHANNEL_TEXT.channelLabel + ":";
    label.style.cssText = "flex:0 0 auto;font-size:16px;";

    var select = document.createElement("select");
    select.setAttribute("data-plotina-channel", "");
    select.setAttribute("aria-label", CHANNEL_TEXT.channelLabel);
    select.style.cssText = "font:inherit;max-width:220px;flex:0 0 auto;";
    var optStable = document.createElement("option");
    optStable.value = "stable";
    optStable.textContent = CHANNEL_TEXT.stableLabel;
    var optDev = document.createElement("option");
    optDev.value = "dev";
    optDev.textContent = CHANNEL_TEXT.devLabel;
    select.appendChild(optStable);
    select.appendChild(optDev);

    var checkBtn = document.createElement("button");
    checkBtn.type = "button";
    checkBtn.textContent = CHANNEL_TEXT.checkForUpdates;
    checkBtn.style.cssText = "font:inherit;flex:0 0 auto;padding:3px 12px;cursor:pointer;";

    var noteEl = document.createElement("div");
    noteEl.setAttribute("data-plotina-channel-note", "");
    noteEl.style.cssText = "flex-basis:100%;font-size:12px;opacity:.6;";

    var statusEl = document.createElement("div");
    statusEl.setAttribute("data-plotina-channel-status", "");
    statusEl.style.cssText = "flex-basis:100%;font-size:12px;opacity:.8;margin-top:4px;";

    var currentChannel = "stable";
    var pinnedByEnv = false;

    function paintState(state) {
      if (!state || !state.channel) return;
      var t = state.text;
      if (t) {
        Object.keys(CHANNEL_TEXT).forEach(function (k) {
          if (typeof t[k] === "string" && t[k]) CHANNEL_TEXT[k] = t[k];
        });
      }
      currentChannel = state.channel === "dev" ? "dev" : "stable";
      pinnedByEnv = !!state.pinnedByEnv;
      select.disabled = pinnedByEnv;
      select.value = currentChannel;
      heading.textContent = CHANNEL_TEXT.channelLabel;
      label.textContent = CHANNEL_TEXT.channelLabel + ":";
      optStable.textContent = CHANNEL_TEXT.stableLabel;
      optDev.textContent = CHANNEL_TEXT.devLabel;
      checkBtn.textContent = CHANNEL_TEXT.checkForUpdates;
      noteEl.textContent =
        "Текущий канал: " +
        (currentChannel === "dev" ? CHANNEL_TEXT.devLabel : CHANNEL_TEXT.stableLabel) +
        (state.currentVersion ? " · версия " + state.currentVersion : "") +
        (pinnedByEnv ? " · закреплён переменной окружения" : "");
    }

    function setChannelValue(next) {
      select.disabled = true;
      Promise.resolve(up.channel.set(next, { acknowledged: next === "dev" })).then(
        function (res) {
          if (res && res.ok) {
            paintState(res.state || { channel: next });
            statusEl.textContent = "";
            return;
          }
          select.disabled = pinnedByEnv;
          select.value = currentChannel;
          if (res && res.needsConfirmation) {
            statusEl.textContent = "Подтверждение не получено — канал не изменён";
          } else {
            statusEl.textContent = "Ошибка: " + ((res && res.error) || "не удалось изменить канал");
          }
        },
        function (e) {
          select.disabled = pinnedByEnv;
          select.value = currentChannel;
          statusEl.textContent = "Ошибка: " + errText(e);
        }
      );
    }

    // Dev is an explicit opt-in: mirror the native menu's warning dialog before
    // the set call. Without the acknowledgement the main process refuses anyway
    // (writeChannel -> needsConfirmation), so this confirm is the only gate.
    select.addEventListener("change", function () {
      var next = select.value;
      if (next === currentChannel) return;
      if (next === "dev") {
        var ok = false;
        try {
          ok = global.confirm(CHANNEL_TEXT.devWarningMessage + "\n\n" + CHANNEL_TEXT.devWarningDetail);
        } catch (e) {
          ok = false;
        }
        if (!ok) {
          select.value = currentChannel;
          return;
        }
      }
      setChannelValue(next);
    });

    checkBtn.addEventListener("click", function () {
      if (typeof up.checkForUpdates !== "function") return;
      checkBtn.disabled = true;
      statusEl.textContent = "Проверяю обновления…";
      Promise.resolve(up.checkForUpdates()).then(
        function () {
          checkBtn.disabled = false;
          // Real outcome arrives later as an 'update-status' event.
        },
        function (e) {
          checkBtn.disabled = false;
          statusEl.textContent = "Ошибка: " + errText(e);
        }
      );
    });

    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(checkBtn);
    row.appendChild(noteEl);
    row.appendChild(statusEl);
    block.appendChild(heading);
    block.appendChild(card);
    card.appendChild(row);

    Promise.resolve()
      .then(function () {
        return up.channel.get();
      })
      .then(
        function (state) {
          paintState(state);
        },
        function (e) {
          statusEl.textContent = "Ошибка: " + errText(e);
        }
      );
    subscribeChannelStatus();
    return block;
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

    /* Backend selector. The Cinny page itself never captures audio: the value
       is written to the shared storage key and picked up live by boot.js in
       the embedded Element Call frame (same origin, "storage" event). */
    var beRow = document.createElement("div");
    beRow.setAttribute("data-plotina-backend-row", "");
    beRow.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:14px;";
    var beLabel = document.createElement("span");
    beLabel.textContent = (s.backend || "Noise suppression") + ":";
    beLabel.style.cssText = "flex:0 0 auto;font-size:16px;";
    var beSelect = document.createElement("select");
    beSelect.setAttribute("data-plotina-backend", "");
    beSelect.setAttribute("aria-label", s.backend || "Noise suppression");
    // Native select on purpose. The old WebKitGTK build could not paint a
    // native field in a dark theme, so we faked one (appearance:none, SVG
    // caret, color-scheme, recoloured options). Lite is Electron now and
    // Chromium renders <select> correctly, so keep the platform control and
    // touch only layout here.
    beSelect.style.cssText = "font:inherit;max-width:220px;flex:0 0 auto;";
    if (L && L.BACKENDS) {
      L.BACKENDS.forEach(function (id) {
        var opt = document.createElement("option");
        opt.value = id;
        opt.textContent = L.BACKEND_LABELS[id];
        beSelect.appendChild(opt);
      });
      beSelect.value = readBackend();
      beSelect.addEventListener("change", function () {
        writeBackend(beSelect.value);
      });
    }
    var beNote = document.createElement("span");
    beNote.setAttribute("data-plotina-backend-note", "");
    beNote.textContent = L && L.strings && L.strings(lang).backendNote || "";
    beNote.style.cssText = "flex-basis:100%;font-size:12px;opacity:.6;";
    beRow.appendChild(beLabel);
    beRow.appendChild(beSelect);
    beRow.appendChild(beNote);

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
    card.appendChild(beRow);
    block.appendChild(heading);
    block.appendChild(card);
    // Lite Desktop only: the update-channel card sits in the same container,
    // so the existing BLOCK_ID guard already prevents duplicate injection on
    // settings re-renders (inject() returns early while the block is alive).
    var chBlock = buildChannelBlock(surface);
    if (chBlock) block.appendChild(chBlock);
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
