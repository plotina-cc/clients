/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Plotina Web/Desktop overlay: personal names for CONTACTS.

Renaming a DM in Element writes m.room.name into the room state, so the other
participant sees the new name too. What we want is the thing every messenger
has: the nickname a person chose, their display name by default, and a name you
gave them that only you see. So the name is bound to the person (their MXID),
not to the dialogue:

    cc.plotina.contact_names = { "@bob:plotina.cc": "Денчик" }

One person with two DMs carries one name in both of them, immediately. A group
room never takes a contact's name: the name belongs to a person, and a room's
own m.room.name is what everyone in a group sees. Nothing here writes
m.room.name or m.room.member, so the other side never learns the name.

How it attaches without a rebuild:

  * matrix-js-sdk v44 keeps the computed name in Room.name, an OWN property
    recomputed by Room.recalculate() -> Room.calculateRoomName(). So there is
    no getter to override per instance; the hook is the prototype method, and
    `window.mxMatrixClientPeg` (set by matrix-react-sdk's init, verified in the
    v1.12.32 bundle) is the way to reach a Room instance from outside. We take
    the prototype from the first room the client has, wrap calculateRoomName
    once, and answer with the contact's name when the room is a DM with that
    person. The room list tile, the room header, notifications and toasts all
    read Room.name, so they follow without any DOM rewriting and without racing
    React.
  * The browser tab title is the one surface that does NOT follow at once:
    matrix-react-sdk recomputes it on room switches, so it picks the name up
    the next time the user changes room.
  * Room.calculateRoomName also serves getDefaultRoomName() with
    ignoreRoomNameEvent=true; that call is left untouched, so "the default
    name of this room" keeps meaning the real one.
  * Recalculating is enough to repaint: Room.recalculate() emits Room.name,
    which is what matrix-react-sdk subscribes to. We call it for every room
    after the name map changes and after the first sync.

Which person a room is a dialogue with comes from room DATA, never from the
room id's shape: "!localpart:server" (room versions up to 11) and the opaque
"!<base64url>" of room version 12 have nothing in common but the leading "!",
and Synapse creates v12 rooms by default since 1.162, so production DMs are
opaque. The partner is what m.direct says, or else the other member of a room
with exactly two joined members (how Element itself presents a one-to-one
chat). Any other member count means no contact, so no name.

Storage: account data is per-user and server-side, so the name follows the
account to any device running this overlay and is invisible to other members.
Plotina Lite, X and Mobile read and write the same event, so a name set in one
client shows up in the others.

Reset writes the map without the key, and every write is sanitised, so the
stored object never carries empty values: removing the last name leaves {}.
The account data event itself stays behind as {}: matrix-js-sdk 44 implements
deleteAccountData(type) as setAccountData(type, {}), and Matrix has no
client-side removal for account data. The old room-keyed model
(cc.plotina.room_aliases) is neither read nor migrated: it is gone.

UI: a pencil button in the open DM's header, on the same line and right after
the room name (it sits next to the name span inside the header's flex row, not
under it), opens a small dialog ("Переименовать для себя" / "Сбросить"). The
DOM anchors follow the same pattern as noise/boot.js and
plotina-update-channel.js: locate by class, insert once, re-insert after
re-renders.

Test handle: window.plotinaContactNames exposes the name map plus set/clear/
refresh so QA can drive the same code path the dialog uses. Invalid ids and
non-DM rooms reject with a coded Error and a visible banner, never silence.
*/
(function (root) {
  "use strict";

  var ACCOUNT_DATA_TYPE = "cc.plotina.contact_names";
  var DIRECT_EVENT_TYPE = "m.direct";
  var CLIENT_POLL_MS = 250;

  /**
   * Matrix user ids: "@localpart:server". The localpart is not empty (the
   * colon is at index > 1) and so is not the server part; whitespace and "/"
   * never appear. This is only used to keep junk out of the map -- it is never
   * used to decide who a person is.
   */
  function isUserId(id) {
    if (typeof id !== "string" || id.charAt(0) !== "@") return false;
    if (/[\s\/]/.test(id)) return false;
    var colon = id.indexOf(":");
    return colon > 1 && colon < id.length - 1;
  }

  /**
   * Room versions <= 11: "!localpart:server". Room version 12: opaque
   * "!<base64url>" with no server part. The only shape both share is the
   * leading "!" and the absence of whitespace and "/" — anything stricter
   * (the old /^!.*:./) drops every v12 room, which was the QA defect.
   */
  function isRoomId(id) {
    return typeof id === "string" && id.length > 1 && id.charAt(0) === "!" &&
      !/[\s\/]/.test(id);
  }

  var STRINGS = {
    ru: {
      title: "Личное имя",
      hint: "Видно только вам. Имя собеседника у него самого не меняется.",
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
      hint: "Only you see this. The contact's own name for everyone else is unchanged.",
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
    // mxid -> personal name
    names: {},
    // room_id -> user_id for this account's m.direct rooms; refreshed on
    // every apply() and on m.direct changes. Used to answer "who is this DM
    // with?" without asking the room id's shape.
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

  function myUserId() {
    var c = state.client || client();
    var id = c && typeof c.getUserId === "function" ? c.getUserId() : null;
    return isUserId(id) ? id : null;
  }

  /** Account data content -> {mxid: name}, strings only, trimmed. */
  function parseContactNames(content) {
    var out = {};
    if (!content || typeof content !== "object" || Array.isArray(content)) return out;
    Object.keys(content).forEach(function (userId) {
      var value = content[userId];
      if (typeof value !== "string" || !value.trim()) return;
      if (!isUserId(userId)) {
        warnOnce(userId);
        return;
      }
      out[userId] = value.trim();
    });
    return out;
  }

  // A payload from a buggy version or another client must not spam the
  // console on every sync; report each dropped key once, loudly enough to be
  // visible in the client log as the "why is my name gone" trace.
  var warnedKeys = {};
  function warnOnce(key) {
    if (warnedKeys[key] || typeof console === "undefined" || !console.warn) return;
    warnedKeys[key] = true;
    console.warn("[plotina-contact-names] ignoring a name for a key that is not " +
      "an mxid: " + JSON.stringify(key));
  }

  function readNames(c) {
    if (!c || typeof c.getAccountData !== "function") return {};
    var event = c.getAccountData(ACCOUNT_DATA_TYPE);
    if (!event || typeof event.getContent !== "function") return {};
    try {
      return parseContactNames(event.getContent());
    } catch (e) {
      return {};
    }
  }

  /** Immutable update: returns a copy of *map* with one contact set or removed. */
  function withContactName(map, userId, name) {
    var next = {};
    Object.keys(map || {}).forEach(function (key) {
      next[key] = map[key];
    });
    if (name && String(name).trim()) next[userId] = String(name).trim();
    else delete next[userId];
    return next;
  }

  /** The name this account gave a contact, or null when nobody set one. */
  function contactNameFor(map, userId) {
    if (!isUserId(userId)) return null;
    var value = map && map[userId];
    if (typeof value !== "string") return null;
    value = value.trim();
    return value || null;
  }

  /**
   * Who is this room a dialogue with, or null when it is not a one-to-one
   * chat? Pure: m.direct first, then exactly two joined members. The room id
   * is only a map key here -- both id shapes (v<=11 and the opaque v12) work
   * because nothing about the id is inspected.
   */
  function dmPartnerId(roomId, meId, direct, joinedIds) {
    var listed = direct && roomId ? direct[roomId] : null;
    if (isUserId(listed)) return listed === meId ? null : listed;
    if (!Array.isArray(joinedIds) || joinedIds.length !== 2) return null;
    var other = joinedIds[0] === meId ? joinedIds[1] : joinedIds[0];
    return isUserId(other) && other !== meId ? other : null;
  }

  /**
   * The name the overlay shows for a room, or null for "keep the room's own".
   * Pure: a room only takes a contact's name when it is a one-to-one dialogue,
   * so a name you gave a person can never mask a group's real name. The name
   * is looked up by the PARTNER's mxid, which is what makes one person with
   * two DMs show the same name in both.
   */
  function contactNameForRoom(map, roomId, meId, direct, joinedIds) {
    var partner = dmPartnerId(roomId, meId, direct, joinedIds);
    if (!partner) return null;
    return contactNameFor(map, partner);
  }

  /**
   * Why a change request must be refused, or null when it may go ahead.
   * Pure, so the node tests pin both id shapes (v12 opaque included) and the
   * DM-only rule without a browser.
   */
  function nameRejection(roomId, name, room) {
    if (!isRoomId(roomId)) return "invalid_room_id";
    var wanted = String(name === undefined || name === null ? "" : name).trim();
    if (!wanted) return null;
    if (!room || !room.known) return "unknown_room";
    if (!room.direct) return "not_direct";
    return null;
  }

  /* --------------------------------------------------------------- SDK hook */

  /**
   * Wrap Room.prototype.calculateRoomName once. The name answer is supplied
   * per room by *resolve*, so the hook always sees the room it is naming and
   * is testable with a fake proto. ignoreRoomNameEvent=true is
   * getDefaultRoomName()'s call and stays stock.
   */
  function installNameHook(proto, resolve) {
    if (!proto || typeof proto.calculateRoomName !== "function") return false;
    if (proto.__plotinaContactNames) return true;
    var original = proto.calculateRoomName;
    proto.calculateRoomName = function (userId, ignoreRoomNameEvent) {
      if (!ignoreRoomNameEvent) {
        var name = resolve(this);
        if (name) return name;
      }
      return original.apply(this, arguments);
    };
    proto.__plotinaContactNames = true;
    return true;
  }

  function patchRooms(c) {
    var rooms = c.getRooms ? c.getRooms() : [];
    if (!rooms || !rooms.length) return false;
    var patched = installNameHook(Object.getPrototypeOf(rooms[0]), nameForRoom);
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

  /** m.direct content -> {room_id: user_id}; only sane keys and ids are kept. */
  function readDirectRooms(c) {
    var out = {};
    if (!c || typeof c.getAccountData !== "function") return out;
    var event = c.getAccountData(DIRECT_EVENT_TYPE);
    var content = event && typeof event.getContent === "function" ? event.getContent() : null;
    if (!content || typeof content !== "object") return out;
    Object.keys(content).forEach(function (userId) {
      var list = content[userId];
      if (!Array.isArray(list) || !isUserId(userId)) return;
      list.forEach(function (roomId) {
        if (isRoomId(roomId)) out[roomId] = userId;
      });
    });
    return out;
  }

  /** Joined member ids of a room, or null when the client cannot say. */
  function joinedIds(room) {
    if (!room) return null;
    try {
      if (typeof room.getJoinedMembers === "function") {
        var members = room.getJoinedMembers();
        if (!Array.isArray(members)) return null;
        var ids = [];
        for (var i = 0; i < members.length; i++) {
          var member = members[i];
          var id = member && (member.userId || member.user_id);
          if (typeof id === "string") ids.push(id);
        }
        return ids;
      }
      if (typeof room.getJoinedMemberCount === "function") {
        // No ids available: an empty list of the right length keeps the
        // two-member rule intact, but names nobody, so the room keeps its
        // own name instead of guessing a contact.
        var count = room.getJoinedMemberCount();
        return count === 2 ? [] : null;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /** The mxid this room is a dialogue with, or null. */
  function partnerOf(roomId) {
    var c = state.client || client();
    var room = c && typeof c.getRoom === "function" ? c.getRoom(roomId) : null;
    return dmPartnerId(roomId, myUserId(), state.direct, joinedIds(room));
  }

  /**
   * The name to show for one room instance, or null for the room's own name.
   * The partner is resolved from the room's members, so a room that has not
   * loaded them yet keeps its real name until it does -- and apply()
   * recalculates on every sync, so it catches up without a reload.
   */
  function nameForRoom(room) {
    if (!room || !isRoomId(room.roomId)) return null;
    return contactNameForRoom(state.names, room.roomId, myUserId(), state.direct,
      joinedIds(room));
  }

  /** Is this room a personal dialogue for the signed-in account? */
  function isDirectRoom(roomId) {
    if (!isRoomId(roomId)) return false;
    return !!partnerOf(roomId);
  }

  /** What the client knows about a room, for nameRejection(). */
  function roomState(roomId) {
    var c = state.client || client();
    var room = c && typeof c.getRoom === "function" ? c.getRoom(roomId) : null;
    return { known: !!(room || state.direct[roomId]), direct: isDirectRoom(roomId) };
  }

  /** Swap the name map in and repaint every room that might be affected. */
  function apply(names) {
    state.names = names;
    var c = state.client || client();
    if (!c) return;
    // m.direct is part of the answer, so re-read it together with the names:
    // a room can become (or stop being) a DM between two syncs.
    state.direct = readDirectRooms(c);
    if (patchRooms(c)) recalculateRooms(c);
    var event = document.getElementById("plotina-contact-name-dialog");
    if (event) syncDialog();
  }

  function refresh() {
    var c = state.client || client();
    if (!c) return {};
    apply(readNames(c));
    return state.names;
  }

  /* ------------------------------------------------------------ account data */

  function writeNames(next) {
    var c = state.client || client();
    if (!c) return Promise.reject(new Error("no Matrix client yet"));
    // Write the sanitised map, never the caller's object: blank names and keys
    // that are not mxids must not reach the server, and removing the last name
    // writes {} with no empty values.
    var clean = parseContactNames(next);
    return c.setAccountData(ACCOUNT_DATA_TYPE, clean).then(function () {
      // Apply locally at once; the accountData sync event re-reads the same
      // map, so this is idempotent rather than racy.
      apply(clean);
      return state.names;
    });
  }

  /** Coded error the UI can translate; the message is already human-facing. */
  function nameError(code, roomId) {
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

  /**
   * Set ("Денчик") or reset (blank) the personal name of the CONTACT this DM
   * is with. The room only identifies the person; the name is stored under
   * their mxid, so every other dialogue with them follows at once.
   */
  function setAlias(roomId, name) {
    var rejection = nameRejection(roomId, name, roomState(roomId));
    if (rejection) {
      // A refused write must never be a silent no-op: say why, in the dialog
      // and in a banner, and still reject so callers (the test handle) see it.
      var err = nameError(rejection, roomId);
      showError(err.message);
      return Promise.reject(err);
    }
    var wanted = String(name === undefined || name === null ? "" : name).trim();
    var partner = partnerOf(roomId);
    if (!partner) {
      // No contact means no key to write and none to drop: refuse out loud
      // instead of storing a name nobody can be shown under.
      var noPartner = nameError("not_direct", roomId);
      showError(noPartner.message);
      return Promise.reject(noPartner);
    }
    return writeNames(withContactName(state.names, partner, wanted));
  }

  function clearAlias(roomId) {
    return setAlias(roomId, "");
  }

  /* ---------------------------------------------------------------- wiring */

  function attach(c) {
    if (!c || c.__plotinaContactNamesAttached) return;
    c.__plotinaContactNamesAttached = true;
    state.client = c;

    apply(readNames(c));

    // A room created after startup inherits the patched prototype, but its
    // first name was computed before the patch could see it in some orders;
    // recalculate on arrival so the name wins either way.
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
          apply(parseContactNames(event.getContent ? event.getContent() : null));
        } else if (type === DIRECT_EVENT_TYPE) {
          // A room that just became (or stopped being) a DM changes whose
          // name applies at all; re-read m.direct and repaint.
          apply(state.names);
        }
      });
      c.on("sync", function (syncState) {
        if (syncState === "PREPARED" || syncState === "SYNCING") {
          // The first sync is where both the rooms and the account data
          // arrive; reading again costs nothing on later ones.
          apply(readNames(c));
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
    // then login without a reload). The name map and the prototype patch
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

  var STYLE_ID = "plotina-contact-name-style";
  var CSS = [
    ".plotina-alias-btn{display:inline-flex;align-items:center;justify-content:center;",
    "flex:0 0 auto;width:28px;height:28px;margin-inline-start:0;padding:0;border:0;border-radius:6px;",
    "background:transparent;color:inherit;cursor:pointer;opacity:.65}",
    ".plotina-alias-btn:hover{opacity:1;background:var(--cpd-color-bg-subtle-secondary,#0001)}",
    ".plotina-alias-btn svg{width:16px;height:16px}",
    "#plotina-contact-name-dialog{position:fixed;inset:0;z-index:10000;display:flex;",
    "align-items:center;justify-content:center;background:#0006}",
    "#plotina-contact-name-dialog .plotina-alias-card{width:min(380px,90vw);padding:20px;",
    "border-radius:12px;background:var(--cpd-color-bg-canvas-default,#fff);color:inherit;",
    "box-shadow:0 12px 40px #0006;font-family:inherit}",
    "#plotina-contact-name-dialog h3{margin:0 0 6px;font-size:16px}",
    "#plotina-contact-name-dialog p{margin:0 0 12px;font-size:13px;opacity:.75;line-height:1.4}",
    "#plotina-contact-name-dialog input{width:100%;box-sizing:border-box;padding:8px 10px;",
    "border:1px solid var(--cpd-color-border-interactive-primary,#8888);border-radius:6px;",
    "font:inherit;background:var(--cpd-color-bg-canvas-default,#fff);color:inherit}",
    "#plotina-contact-name-dialog .plotina-alias-actions{display:flex;gap:8px;margin-top:14px}",
    "#plotina-contact-name-dialog button{padding:7px 12px;border-radius:6px;border:1px solid #8886;",
    "background:transparent;color:inherit;font:inherit;cursor:pointer}",
    "#plotina-contact-name-dialog button.plotina-alias-primary{background:#17795a;border-color:#17795a;",
    "color:#fff}",
    "#plotina-contact-name-dialog .plotina-alias-status{margin-top:10px;font-size:12px;min-height:16px}",
    "#plotina-contact-name-error{position:fixed;top:16px;left:50%;transform:translateX(-50%);",
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
    // Whether the room is a DM is checked against the room data below.
    return isRoomId(id) ? id : null;
  }

  /** Visible refusal: a banner, auto-dismissed, never a silent no-op. */
  function showError(message) {
    if (!message || !document.body) return;
    injectStyle();
    var el = document.getElementById("plotina-contact-name-error");
    if (!el) {
      el = document.createElement("div");
      el.id = "plotina-contact-name-error";
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
    // The name is a personal-dialogue feature: no pencil on a group room,
    // where the name belongs to the room and to everyone in it.
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
    wrap.id = "plotina-contact-name-dialog";
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

  /** The dialog shows the name of the CONTACT this room is a DM with. */
  function syncDialog() {
    var wrap = document.getElementById("plotina-contact-name-dialog");
    if (!wrap || !state.dialogRoomId) return;
    var input = wrap.querySelector("input");
    if (!input || document.activeElement === input) return;
    input.value = contactNameFor(state.names, partnerOf(state.dialogRoomId)) || "";
  }

  function saveFromDialog(value) {
    var roomId = state.dialogRoomId;
    if (!roomId) return;
    var status = document.querySelector("#plotina-contact-name-dialog .plotina-alias-status");
    setAlias(roomId, value).then(function () {
      closeDialog();
    }, function (err) {
      if (status) status.textContent = t().failed + (err && err.message ? err.message : err);
    });
  }

  function closeDialog() {
    var wrap = document.getElementById("plotina-contact-name-dialog");
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

  root.plotinaContactNames = {
    ACCOUNT_DATA_TYPE: ACCOUNT_DATA_TYPE,
    ready: function () {
      return !!(state.client && state.patched);
    },
    names: function () {
      return state.names;
    },
    /** Is the given room a DM for this account (m.direct or 2 members)? */
    isDirect: isDirectRoom,
    /** The mxid this room is a dialogue with, or null. */
    partnerOf: partnerOf,
    refresh: refresh,
    setAlias: setAlias,
    clearAlias: clearAlias,
  };

  /* ------------------------------------------------------------ node tests */

  // CommonJS export for element-web/tests/contact_names.test.js: the pure
  // pieces only. node has no DOM and no Matrix client, so the browser entry
  // point below is skipped there (branding_test.py wires the test into the
  // suite).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ACCOUNT_DATA_TYPE: ACCOUNT_DATA_TYPE,
      DIRECT_EVENT_TYPE: DIRECT_EVENT_TYPE,
      isUserId: isUserId,
      isRoomId: isRoomId,
      parseContactNames: parseContactNames,
      withContactName: withContactName,
      contactNameFor: contactNameFor,
      dmPartnerId: dmPartnerId,
      contactNameForRoom: contactNameForRoom,
      nameRejection: nameRejection,
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
