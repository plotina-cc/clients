/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Plotina Web/Desktop overlay: personal room names ("алиасы") for one account.

Renaming a DM in Element writes m.room.name into the room state, so the other
participant sees the new name too. What we want is a name that lives in the
account and nowhere else: a map room_id -> label in account data under
cc.plotina.room_aliases, applied by the client when it renders the room.

How it attaches without a rebuild (see SPIKE-dm-aliases.md, "Как мы правим
element-web"):

  * matrix-js-sdk v44 keeps the computed name in Room.name, an OWN property
    recomputed by Room.recalculate() -> Room.calculateRoomName(). So there is
    no getter to override per instance; the hook is the prototype method, and
    `window.mxMatrixClientPeg` (set by matrix-react-sdk's init, verified in the
    v1.12.32 bundle) is the way to reach a Room instance from outside. We take
    the prototype from the first room the client has, wrap calculateRoomName
    once, and answer with the alias when the room has one. The room list tile,
    the room header, notifications and toasts all read Room.name, so they
    follow without any DOM rewriting and without racing React.
  * The browser tab title is the one surface that does NOT follow at once:
    matrix-react-sdk recomputes it on room switches, so it picks the alias up
    the next time the user changes room (measured; see SPIKE-dm-aliases.md §5).
  * Room.calculateRoomName also serves getDefaultRoomName() with
    ignoreRoomNameEvent=true; that call is left untouched, so "the default
    name of this room" keeps meaning the real one.
  * Recalculating is enough to repaint: Room.recalculate() emits Room.name,
    which is what matrix-react-sdk subscribes to. We call it for every room
    after the alias map changes and after the first sync.

Storage: account data is per-user and server-side, so the alias follows the
account to any device running this overlay and is invisible to other members.
Nothing here touches room state or sync.

UI: a pencil button in the open room's header, on the same line and right
after the room name (it sits next to the name span inside the header's flex
row, not under it), opens a small dialog ("Переименовать для себя" /
"Сбросить"). The DOM anchors follow the same pattern as noise/boot.js and
plotina-update-channel.js: locate by class, insert once, re-insert after
re-renders.

Room ids: "!localpart:server" (room versions up to 11) and the opaque
"!<base64url>" of room version 12 have nothing in common but the leading "!".
Synapse creates v12 rooms by default since 1.162, so production DMs are
opaque and any format rule stricter than "starts with !, no whitespace or
slash" silently hides the feature (the QA defect). Which room a request
belongs to is therefore checked against the room data — the room object of
this client and its m.direct/member list — not against an id shape.

Only personal dialogues: the alias UI and setter apply to rooms this account
has as a DM (listed in m.direct, or exactly two joined members). A group
room's name is the room's own name; it is never masked locally (QA finding).

Reset writes the map without the key, and every write is sanitised, so the
stored object never carries empty values: removing the last alias leaves
{}. The account data event itself stays behind as {}: matrix-js-sdk 44
implements deleteAccountData(type) as setAccountData(type, {}), and Matrix
has no client-side removal for account data.

Test handle: window.plotinaDmAliases exposes the alias map plus set/clear/
refresh so QA can drive the same code path the dialog uses. Invalid ids and
non-DM rooms reject with a coded Error and a visible banner, never silence.
*/
(function (root) {
  "use strict";

  var ACCOUNT_DATA_TYPE = "cc.plotina.room_aliases";
  var DIRECT_EVENT_TYPE = "m.direct";
  var CLIENT_POLL_MS = 250;

  /**
   * Room versions <= 11: "!localpart:server". Room version 12: opaque
   * "!<base64url>" with no server part. The only shape both share is the
   * leading "!" and the absence of whitespace and "/" — anything stricter
   * (the old /^!.*:./) drops every v12 room, which is the QA defect.
   */
  function isRoomId(id) {
    return typeof id === "string" && id.length > 1 && id.charAt(0) === "!" &&
      !/[\s\/]/.test(id);
  }

  var STRINGS = {
    ru: {
      title: "Личное имя",
      hint: "Видно только вам. Имя комнаты у собеседника не меняется.",
      save: "Сохранить",
      reset: "Сбросить",
      cancel: "Отмена",
      button: "Переименовать для себя",
      saved: "Имя сохранено",
      failed: "Не удалось сохранить имя: ",
      invalid: "Некорректный id комнаты: ",
      unknown: "Комната не найдена в этом клиенте — обновите страницу.",
      notDirect: "Личное имя доступно только в личных диалогах.",
    },
    en: {
      title: "Personal name",
      hint: "Only you see this. The room's name for everyone else is unchanged.",
      save: "Save",
      reset: "Reset",
      cancel: "Cancel",
      button: "Rename for myself",
      saved: "Name saved",
      failed: "Could not save the name: ",
      invalid: "Invalid room id: ",
      unknown: "This room is not in the current client — reload the page.",
      notDirect: "A personal name is only available for direct messages.",
    },
  };

  function t() {
    var lang = (document.documentElement.lang || navigator.language || "").toLowerCase();
    return lang.indexOf("ru") === 0 ? STRINGS.ru : STRINGS.en;
  }

  var state = {
    aliases: {},
    // room_id -> user_id for this account's m.direct rooms; refreshed on
    // every apply() and on m.direct changes. Used to answer "is this a DM?"
    // without asking the id's shape.
    direct: {},
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
      if (typeof value !== "string" || !value.trim()) return;
      if (!isRoomId(roomId)) {
        warnOnce(roomId);
        return;
      }
      out[roomId] = value.trim();
    });
    return out;
  }

  // A payload from a buggy version or another client must not spam the
  // console on every sync; report each dropped key once, loudly enough to be
  // visible in the client log as the "why is my alias gone" trace.
  var warnedKeys = {};
  function warnOnce(roomId) {
    if (warnedKeys[roomId] || typeof console === "undefined" || !console.warn) return;
    warnedKeys[roomId] = true;
    console.warn("[plotina-dm-aliases] ignoring alias for a key that is not a " +
      "room id: " + JSON.stringify(roomId));
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

  /** Immutable update: returns a copy of *map* with one room set or removed. */
  function withAlias(map, roomId, name) {
    var next = {};
    Object.keys(map || {}).forEach(function (key) {
      next[key] = map[key];
    });
    if (name && String(name).trim()) next[roomId] = String(name).trim();
    else delete next[roomId];
    return next;
  }

  /**
   * The name the overlay shows for a room, or null for "keep the room's own".
   * Pure: a room only takes its alias when it is a personal dialogue, so a
   * stale alias for a group room can never mask that room's real name.
   */
  function aliasFor(map, roomId, direct) {
    if (!direct) return null;
    var value = map && map[roomId];
    if (typeof value !== "string") return null;
    value = value.trim();
    return value || null;
  }

  /**
   * Why a change request must be refused, or null when it may go ahead.
   * Pure, so the node tests pin both id shapes (v12 opaque included) and the
   * DM-only rule without a browser. Clearing (blank name) is only checked for
   * the id: a stale alias must stay removable even when the room is gone.
   */
  function aliasRejection(roomId, name, room) {
    if (!isRoomId(roomId)) return "invalid_room_id";
    var wanted = String(name === undefined || name === null ? "" : name).trim();
    if (!wanted) return null;
    if (!room || !room.known) return "unknown_room";
    if (!room.direct) return "not_direct";
    return null;
  }

  /* --------------------------------------------------------------- SDK hook */

  /**
   * Wrap Room.prototype.calculateRoomName once. The alias answer is supplied
   * per room by *resolve*, so the hook itself is testable with a fake proto.
   * ignoreRoomNameEvent=true is getDefaultRoomName()'s call and stays stock.
   */
  function installNameHook(proto, resolve) {
    if (!proto || typeof proto.calculateRoomName !== "function") return false;
    if (proto.__plotinaRoomAliases) return true;
    var original = proto.calculateRoomName;
    proto.calculateRoomName = function (userId, ignoreRoomNameEvent) {
      if (!ignoreRoomNameEvent) {
        var alias = resolve(this.roomId);
        if (alias) return alias;
      }
      return original.apply(this, arguments);
    };
    proto.__plotinaRoomAliases = true;
    return true;
  }

  function patchRooms(c) {
    var rooms = c.getRooms ? c.getRooms() : [];
    if (!rooms || !rooms.length) return false;
    var patched = installNameHook(Object.getPrototypeOf(rooms[0]), function (roomId) {
      return aliasFor(state.aliases, roomId, isDirectRoom(roomId));
    });
    if (patched) state.patched = true;
    return patched;
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

  /* --------------------------------------------------------- DM detection */

  /** m.direct content -> {room_id: user_id}; only room ids are kept. */
  function readDirectRooms(c) {
    var out = {};
    if (!c || typeof c.getAccountData !== "function") return out;
    var event = c.getAccountData(DIRECT_EVENT_TYPE);
    var content = event && typeof event.getContent === "function" ? event.getContent() : null;
    if (!content || typeof content !== "object") return out;
    Object.keys(content).forEach(function (userId) {
      var list = content[userId];
      if (!Array.isArray(list)) return;
      list.forEach(function (roomId) {
        if (isRoomId(roomId)) out[roomId] = userId;
      });
    });
    return out;
  }

  /** Joined member count of a room, or null when the client cannot say. */
  function joinedCount(room) {
    if (!room) return null;
    try {
      if (typeof room.getJoinedMemberCount === "function") {
        var count = room.getJoinedMemberCount();
        if (typeof count === "number") return count;
      }
      if (typeof room.getJoinedMembers === "function") {
        var members = room.getJoinedMembers();
        if (members) return members.length;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /**
   * Is this room a personal dialogue for the signed-in account? Room data,
   * not the id: v12 opaque ids carry no server part and no shape to test.
   * A DM is a room m.direct lists, or a room with exactly two joined members
   * (which is how Element itself presents one-to-one chats). Member data can
   * arrive after the first name calculation; the SDK recalculates on member
   * changes, and apply() recalculates on every sync.
   */
  function isDirectRoom(roomId) {
    if (state.direct[roomId]) return true;
    var c = state.client || client();
    var room = c && typeof c.getRoom === "function" ? c.getRoom(roomId) : null;
    return joinedCount(room) === 2;
  }

  /** What the client knows about a room, for aliasRejection(). */
  function roomState(roomId) {
    var c = state.client || client();
    var room = c && typeof c.getRoom === "function" ? c.getRoom(roomId) : null;
    return { known: !!(room || state.direct[roomId]), direct: isDirectRoom(roomId) };
  }

  /** Swap the alias map in and repaint every room that might be affected. */
  function apply(aliases) {
    state.aliases = aliases;
    var c = state.client || client();
    if (!c) return;
    state.direct = readDirectRooms(c);
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
    // Write the sanitised map, never the caller's object: blank labels and
    // keys that are not room ids must not reach the server (QA finding on
    // reset), and removing the last alias writes {} with no empty values.
    var clean = parseAliases(next);
    return c.setAccountData(ACCOUNT_DATA_TYPE, clean).then(function () {
      // Apply locally at once; the accountData sync event re-reads the same
      // map, so this is idempotent rather than racy.
      apply(clean);
      return state.aliases;
    });
  }

  /** Coded error the UI can translate; the message is already human-facing. */
  function aliasError(code, roomId) {
    var s = t();
    var messages = {
      invalid_room_id: s.invalid + JSON.stringify(String(roomId)),
      unknown_room: s.unknown,
      not_direct: s.notDirect,
    };
    var err = new Error(messages[code] || code);
    err.code = code;
    return err;
  }

  function setAlias(roomId, name) {
    var rejection = aliasRejection(roomId, name, roomState(roomId));
    if (rejection) {
      // The QA defect was a silent no-op: the write went through, nothing
      // changed on screen. A refused write now says why, in the dialog and in
      // a banner, and still rejects so callers (the test handle) see it.
      var err = aliasError(rejection, roomId);
      showError(err.message);
      return Promise.reject(err);
    }
    return writeAliases(withAlias(state.aliases, roomId, name));
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
        if (!event || typeof event.getType !== "function") return;
        var type = event.getType();
        if (type === ACCOUNT_DATA_TYPE) {
          apply(parseAliases(event.getContent ? event.getContent() : null));
        } else if (type === DIRECT_EVENT_TYPE) {
          // A room that just became (or stopped being) a DM changes whether
          // its alias applies at all; re-read m.direct and repaint.
          apply(state.aliases);
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
    "flex:0 0 auto;width:28px;height:28px;margin-inline-start:0;padding:0;border:0;border-radius:6px;",
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
    "#plotina-dm-alias-error{position:fixed;top:16px;left:50%;transform:translateX(-50%);",
    "z-index:10001;max-width:min(520px,92vw);padding:10px 14px;border-radius:8px;",
    "background:#8a1f1f;color:#fff;font-size:13px;line-height:1.4;font-family:inherit;",
    "box-shadow:0 8px 24px #0006}",
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
    // v12 opaque ids are legitimate: a leading "!" is the whole contract.
    // Whether the room is usable is checked against the room data below.
    return isRoomId(id) ? id : null;
  }

  /** Visible refusal: a banner, auto-dismissed, never a silent no-op. */
  function showError(message) {
    if (!message || !document.body) return;
    injectStyle();
    var el = document.getElementById("plotina-dm-alias-error");
    if (!el) {
      el = document.createElement("div");
      el.id = "plotina-dm-alias-error";
      el.setAttribute("role", "alert");
      document.body.appendChild(el);
    }
    el.textContent = message;
    root.clearTimeout(showError.timer);
    showError.timer = root.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 8000);
  }

  /**
   * The header box that renders the room name. In the pinned v1.12.32 the
   * name is <span class="mx_RoomHeader_truncated"> inside the flex row
   * .mx_RoomHeader_heading (RoomHeader.tsx: Text as div -> truncated span +
   * status/verified icons). Older layouts exposed .mx_RoomHeader_name /
   * .mx_RoomHeader_info; keep those as a fallback so a header change puts the
   * pencil back under the name instead of nowhere.
   */
  function headerNameRow() {
    var header = document.querySelector(".mx_RoomHeader");
    if (!header) return null;
    return header.querySelector(".mx_RoomHeader_heading") ||
      header.querySelector(".mx_RoomHeader_info, .mx_RoomHeader_name");
  }

  /** Drop the pencil from whatever header is on screen (left a DM, group room). */
  function removeHeaderButton() {
    var buttons = document.querySelectorAll(".mx_RoomHeader .plotina-alias-btn");
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].parentNode) buttons[i].parentNode.removeChild(buttons[i]);
    }
  }

  /**
   * Put the pencil into the name row, directly after the name text: the row is
   * already a flex container, so the button takes its place in the flow and
   * the name truncates around it. No absolute positioning, nothing overlaps
   * the call/invite buttons that live outside this row.
   */
  function insertAfterName(row, button) {
    var name = row.querySelector(".mx_RoomHeader_truncated");
    if (name && name.parentNode === row) row.insertBefore(button, name.nextSibling);
    else row.appendChild(button);
  }

  function ensureHeaderButton() {
    var roomId = currentRoomId();
    // The alias is a personal-dialogue feature (QA finding): no pencil on a
    // group room, where the name belongs to the room and to everyone in it.
    if (!roomId || !isDirectRoom(roomId)) {
      removeHeaderButton();
      return;
    }
    var row = headerNameRow();
    if (!row) return;
    // Only the name row itself counts: a leftover button in another header
    // instance must not keep this header empty.
    if (row.querySelector(".plotina-alias-btn")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "plotina-alias-btn";
    button.setAttribute("aria-label", t().button);
    button.title = t().button;
    button.innerHTML = PENCIL;
    button.addEventListener("click", function (ev) {
      // The name row lives inside the "open room summary" button; without
      // this the pencil would open the right panel behind the dialog.
      ev.preventDefault();
      ev.stopPropagation();
      openDialog(currentRoomId());
    });
    insertAfterName(row, button);
  }

  function openDialog(roomId) {
    closeDialog();
    if (!roomId) {
      showError(t().invalid + JSON.stringify(String(roomId)));
      return;
    }
    if (!isDirectRoom(roomId)) {
      showError(t().notDirect);
      return;
    }
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
    // The field starts empty with no example text: the user asked for a bare
    // input (the hint above already says what the name is for).
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
    /** Is the given room a DM for this account (m.direct or 2 members)? */
    isDirect: isDirectRoom,
    refresh: refresh,
    setAlias: setAlias,
    clearAlias: clearAlias,
  };

  /* ------------------------------------------------------------ node tests */

  // CommonJS export for element-web/tests/dm_aliases.test.js: the pure pieces
  // only. node has no DOM and no Matrix client, so the browser entry point
  // below is skipped there (branding_test.py wires the test into the suite).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ACCOUNT_DATA_TYPE: ACCOUNT_DATA_TYPE,
      DIRECT_EVENT_TYPE: DIRECT_EVENT_TYPE,
      isRoomId: isRoomId,
      parseAliases: parseAliases,
      withAlias: withAlias,
      aliasFor: aliasFor,
      aliasRejection: aliasRejection,
      installNameHook: installNameHook,
    };
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof window !== "undefined" ? window : this);