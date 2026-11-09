/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Plotina Web/Desktop overlay: personal room names ("алиасы") for one account.

Renaming a DM in Element writes m.room.name into the room state, so the other
participant sees the new name too. What we want is a name that lives in the
account and nowhere else: a map room_id -> label in account data under
cc.plotina.room_aliases, applied by the client when it renders the room.

How it attaches without a rebuild (see element-web/README.md, "Patch routes"):

  * matrix-js-sdk v44 keeps the computed name in Room.name, an OWN property
    recomputed by Room.recalculate() -> Room.calculateRoomName(). So there is
    no getter to override per instance; the hook is the prototype method, and
    `window.mxMatrixClientPeg` (set by matrix-react-sdk's init, verified in the
    v1.12.32 bundle) is the way to reach a Room instance from outside. We take
    the prototype from the first room the client has, wrap calculateRoomName
    once, and answer with the alias when the room has one. Every consumer
    (room list tile, room header, tab title, reply context) reads Room.name,
    so they all see the alias — no DOM rewriting, no race with React.
  * Room.calculateRoomName also serves getDefaultRoomName() with
    ignoreRoomNameEvent=true; that call is left untouched, so "the default
    name of this room" keeps meaning the real one.
  * Recaclulating is enough to repaint: Room.recalculate() emits Room.name,
    which is what matrix-react-sdk subscribes to. We call it for every room
    after the alias map changes and after the first sync.

Storage: account data is per-user and server-side, so the alias follows the
account to any device running this overlay and is invisible to other members.
Nothing here touches room state or sync.

UI: a pencil button in the open room's header opens a small dialog
("Переименовать для себя" / "Сбросить"). The DOM anchors follow the same
pattern as noise/boot.js and plotina-update-channel.js: locate by class,
insert once, re-insert after re-renders.

Test handle: window.plotinaDmAliases exposes the alias map plus set/clear/
refresh so QA can drive the same code path the dialog uses.
*/
(function (root) {
  "use strict";

  var ACCOUNT_DATA_TYPE = "cc.plotina.room_aliases";
  var ROOM_ID_RE = /^!.*:./;
  var CLIENT_POLL_MS = 250;

  var STRINGS = {
    ru: {
      title: "Личное имя",
      hint: "Видно только вам. Имя комнаты у собеседника не меняется.",
      placeholder: "Например, Денчик",
      save: "Сохранить",
      reset: "Сбросить",
      cancel: "Отмена",
      button: "Переименовать для себя",
      saved: "Имя сохранено",
      failed: "Не удалось сохранить имя: ",
    },
    en: {
      title: "Personal name",
      hint: "Only you see this. The room's name for everyone else is unchanged.",
      placeholder: "e.g. Denchik",
      save: "Save",
      reset: "Reset",
      cancel: "Cancel",
      button: "Rename for myself",
      saved: "Name saved",
      failed: "Could not save the name: ",
    },
  };

  function t() {
    var lang = (document.documentElement.lang || navigator.language || "").toLowerCase();
    return lang.indexOf("ru") === 0 ? STRINGS.ru : STRINGS.en;
  }

  var state = {
    aliases: {},
    client: null,
    patched: false,
    started: false,
    dialogRoomId: null,
  };

  /* ------------------------------------------------------------- helpers */

  function client() {
    var peg = root.mxMatrixClientPeg;
    if (!peg || typeof peg.get !== "function") return null;
    try {
      return peg.get() || null;
    } catch (e) {
      return null;
    }
  }

  /** Account data content -> {room_id: label}, strings only, trimmed. */
  function parseAliases(content) {
    var out = {};
    if (!content || typeof content !== "object") return out;
    Object.keys(content).forEach(function (roomId) {
      var value = content[roomId];
      if (typeof value === "string" && value.trim() && ROOM_ID_RE.test(roomId)) {
        out[roomId] = value.trim();
      }
    });
    return out;
  }

  function readAliases(c) {
    if (!c || typeof c.getAccountData !== "function") return {};
    var event = c.getAccountData(ACCOUNT_DATA_TYPE);
    if (!event || typeof event.getContent !== "function") return {};
    try {
      return parseAliases(event.getContent());
    } catch (e) {
      return {};
    }
  }

  /* --------------------------------------------------------------- SDK hook */

  function patchRooms(c) {
    var rooms = c.getRooms ? c.getRooms() : [];
    if (!rooms || !rooms.length) return false;
    var proto = Object.getPrototypeOf(rooms[0]);
    if (!proto || typeof proto.calculateRoomName !== "function") return false;
    if (proto.__plotinaRoomAliases) {
      state.patched = true;
      return true;
    }
    var original = proto.calculateRoomName;
    proto.calculateRoomName = function (userId, ignoreRoomNameEvent) {
      if (!ignoreRoomNameEvent) {
        var alias = state.aliases[this.roomId];
        if (typeof alias === "string" && alias) return alias;
      }
      return original.apply(this, arguments);
    };
    proto.__plotinaRoomAliases = true;
    state.patched = true;
    return true;
  }

  function recalculateRooms(c) {
    var rooms = c.getRooms ? c.getRooms() : [];
    for (var i = 0; i < rooms.length; i++) {
      var room = rooms[i];
      if (typeof room.recalculate === "function") {
        try {
          room.recalculate(); // emits Room.name when the display name changes
        } catch (e) {
          /* one broken room must not stop the others */
        }
      }
    }
  }

  /** Swap the alias map in and repaint every room that might be affected. */
  function apply(aliases) {
    state.aliases = aliases;
    var c = state.client || client();
    if (!c) return;
    if (patchRooms(c)) recalculateRooms(c);
    var event = document.getElementById("plotina-dm-alias-dialog");
    if (event) syncDialog();
  }

  function refresh() {
    var c = state.client || client();
    if (!c) return {};
    apply(readAliases(c));
    return state.aliases;
  }

  /* ------------------------------------------------------------ account data */

  function writeAliases(next) {
    var c = state.client || client();
    if (!c) return Promise.reject(new Error("no Matrix client yet"));
    return c.setAccountData(ACCOUNT_DATA_TYPE, next).then(function () {
      // Apply locally at once; the accountData sync event re-reads the same
      // map, so this is idempotent rather than racy.
      apply(parseAliases(next));
      return state.aliases;
    });
  }

  function setAlias(roomId, name) {
    var next = {};
    Object.keys(state.aliases).forEach(function (key) {
      next[key] = state.aliases[key];
    });
    if (name && String(name).trim()) next[roomId] = String(name).trim();
    else delete next[roomId];
    return writeAliases(next);
  }

  function clearAlias(roomId) {
    return setAlias(roomId, "");
  }

  /* ---------------------------------------------------------------- wiring */

  function attach(c) {
    if (!c || c.__plotinaDmAliasesAttached) return;
    c.__plotinaDmAliasesAttached = true;
    state.client = c;

    apply(readAliases(c));

    // A room created after startup inherits the patched prototype, but its
    // first name was computed before the patch could see it in some orders;
    // recalculate on arrival so the alias wins either way.
    if (typeof c.on === "function") {
      c.on("Room", function (room) {
        if (patchRooms(c) && room && typeof room.recalculate === "function") {
          try {
            room.recalculate();
          } catch (e) {
            /* ignore */
          }
        }
      });
      c.on("accountData", function (event) {
        if (event && typeof event.getType === "function" &&
            event.getType() === ACCOUNT_DATA_TYPE) {
          apply(parseAliases(event.getContent ? event.getContent() : null));
        }
      });
      c.on("sync", function (syncState) {
        if (syncState === "PREPARED" || syncState === "SYNCING") {
          // The first sync is where both the rooms and the account data
          // arrive; reading again costs nothing on later ones.
          apply(readAliases(c));
        }
      });
    }
  }

  function start() {
    if (state.started) return;
    var c = client();
    if (!c) {
      root.setTimeout(start, CLIENT_POLL_MS);
      return;
    }
    state.started = true;
    attach(c);
    startUi();

    // Element can replace the MatrixClient in place (account switch, logout
    // then login without a reload). The alias map and the prototype patch
    // belong to whatever client object is current, so follow it.
    root.setInterval(function () {
      var current = client();
      if (current && current !== state.client) {
        state.patched = false;
        attach(current);
      }
    }, 2000);
  }

  /* -------------------------------------------------------------------- UI */

  var STYLE_ID = "plotina-dm-alias-style";
  var CSS = [
    ".plotina-alias-btn{display:inline-flex;align-items:center;justify-content:center;",
    "width:28px;height:28px;margin-inline-start:8px;padding:0;border:0;border-radius:6px;",
    "background:transparent;color:inherit;cursor:pointer;opacity:.65}",
    ".plotina-alias-btn:hover{opacity:1;background:var(--cpd-color-bg-subtle-secondary,#0001)}",
    ".plotina-alias-btn svg{width:16px;height:16px}",
    "#plotina-dm-alias-dialog{position:fixed;inset:0;z-index:10000;display:flex;",
    "align-items:center;justify-content:center;background:#0006}",
    "#plotina-dm-alias-dialog .plotina-alias-card{width:min(380px,90vw);padding:20px;",
    "border-radius:12px;background:var(--cpd-color-bg-canvas-default,#fff);color:inherit;",
    "box-shadow:0 12px 40px #0006;font-family:inherit}",
    "#plotina-dm-alias-dialog h3{margin:0 0 6px;font-size:16px}",
    "#plotina-dm-alias-dialog p{margin:0 0 12px;font-size:13px;opacity:.75;line-height:1.4}",
    "#plotina-dm-alias-dialog input{width:100%;box-sizing:border-box;padding:8px 10px;",
    "border:1px solid var(--cpd-color-border-interactive-primary,#8888);border-radius:6px;",
    "font:inherit;background:var(--cpd-color-bg-canvas-default,#fff);color:inherit}",
    "#plotina-dm-alias-dialog .plotina-alias-actions{display:flex;gap:8px;margin-top:14px}",
    "#plotina-dm-alias-dialog button{padding:7px 12px;border-radius:6px;border:1px solid #8886;",
    "background:transparent;color:inherit;font:inherit;cursor:pointer}",
    "#plotina-dm-alias-dialog button.plotina-alias-primary{background:#17795a;border-color:#17795a;",
    "color:#fff}",
    "#plotina-dm-alias-dialog .plotina-alias-status{margin-top:10px;font-size:12px;min-height:16px}",
  ].join("");

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  var PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  function currentRoomId() {
    var hash = location.hash || "";
    var at = hash.indexOf("#/room/");
    if (at !== 0) return null;
    var id = hash.slice("#/room/".length).split("/")[0].split("?")[0];
    try {
      id = decodeURIComponent(id);
    } catch (e) {
      return null;
    }
    return ROOM_ID_RE.test(id) ? id : null;
  }

  function ensureHeaderButton() {
    var roomId = currentRoomId();
    if (!roomId) return;
    var info = document.querySelector(".mx_RoomHeader_info, .mx_RoomHeader_name");
    if (!info) return;
    var existing = info.querySelector(".plotina-alias-btn");
    if (existing) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "plotina-alias-btn";
    button.setAttribute("aria-label", t().button);
    button.title = t().button;
    button.innerHTML = PENCIL;
    button.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openDialog(currentRoomId());
    });
    info.appendChild(button);
  }

  function openDialog(roomId) {
    closeDialog();
    if (!roomId) return;
    state.dialogRoomId = roomId;
    injectStyle();
    var s = t();
    var wrap = document.createElement("div");
    wrap.id = "plotina-dm-alias-dialog";
    wrap.innerHTML =
      '<div class="plotina-alias-card" role="dialog" aria-modal="true">' +
      "<h3></h3><p></p>" +
      '<input type="text" maxlength="128" />' +
      '<div class="plotina-alias-actions">' +
      '<button type="button" class="plotina-alias-primary" data-role="save"></button>' +
      '<button type="button" data-role="reset"></button>' +
      '<button type="button" data-role="cancel"></button>' +
      "</div>" +
      '<div class="plotina-alias-status" role="status"></div>' +
      "</div>";
    wrap.querySelector("h3").textContent = s.title;
    wrap.querySelector("p").textContent = s.hint;
    wrap.querySelector("input").placeholder = s.placeholder;
    wrap.querySelector("input").setAttribute("aria-label", s.title);
    wrap.querySelector('[data-role="save"]').textContent = s.save;
    wrap.querySelector('[data-role="reset"]').textContent = s.reset;
    wrap.querySelector('[data-role="cancel"]').textContent = s.cancel;
    wrap.addEventListener("click", function (ev) {
      if (ev.target === wrap) closeDialog();
    });
    wrap.querySelector('[data-role="cancel"]').addEventListener("click", closeDialog);
    wrap.querySelector('[data-role="save"]').addEventListener("click", function () {
      saveFromDialog(wrap.querySelector("input").value);
    });
    wrap.querySelector('[data-role="reset"]').addEventListener("click", function () {
      saveFromDialog("");
    });
    wrap.querySelector("input").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") saveFromDialog(wrap.querySelector("input").value);
      if (ev.key === "Escape") closeDialog();
    });
    document.body.appendChild(wrap);
    syncDialog();
    wrap.querySelector("input").focus();
  }

  function syncDialog() {
    var wrap = document.getElementById("plotina-dm-alias-dialog");
    if (!wrap || !state.dialogRoomId) return;
    var input = wrap.querySelector("input");
    if (input && document.activeElement !== input) {
      input.value = state.aliases[state.dialogRoomId] || "";
    }
  }

  function saveFromDialog(value) {
    var roomId = state.dialogRoomId;
    if (!roomId) return;
    var status = document.querySelector("#plotina-dm-alias-dialog .plotina-alias-status");
    setAlias(roomId, value).then(function () {
      closeDialog();
    }, function (err) {
      if (status) status.textContent = t().failed + (err && err.message ? err.message : err);
    });
  }

  function closeDialog() {
    var wrap = document.getElementById("plotina-dm-alias-dialog");
    if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    state.dialogRoomId = null;
  }

  function startUi() {
    injectStyle();
    ensureHeaderButton();

    // React re-renders the header on every room switch and on name changes;
    // re-add the button instead of fighting the renderer.
    var scheduled = false;
    var observer = new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      root.setTimeout(function () {
        scheduled = false;
        ensureHeaderButton();
      }, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    root.addEventListener("hashchange", function () {
      root.setTimeout(ensureHeaderButton, 100);
    });
  }

  /* ------------------------------------------------------------ test handle */

  root.plotinaDmAliases = {
    ACCOUNT_DATA_TYPE: ACCOUNT_DATA_TYPE,
    ready: function () {
      return !!(state.client && state.patched);
    },
    aliases: function () {
      return state.aliases;
    },
    refresh: refresh,
    setAlias: setAlias,
    clearAlias: clearAlias,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof window !== "undefined" ? window : this);