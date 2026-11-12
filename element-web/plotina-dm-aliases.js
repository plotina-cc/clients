/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Plotina Web/Desktop overlay: personal contact names for one account.

The name belongs to the PERSON, not to the room. One map in the account's own
account data, cc.plotina.contact_names, keyed by the contact's MXID:

    { "@bob:example.org": "Денчик" }

so a person you renamed is "Денчик" in every direct chat with them, exactly like
a messenger's contact name: nick, default display name, and the name you gave
them yourself are three different things, and the last one wins for you alone.

Nothing here writes room state or another user's profile: the name is private to
this account and the other side never sees it.

The previous model keyed the same idea by room id (cc.plotina.room_aliases). It
is not read and not migrated — the owner asked for a clean cut. The old event is
left where it is: a client cannot delete account data (the SDK's own removal
call is implemented as writing {}), so a "cleanup" would leave an empty event
behind, which is no better than leaving the old map, and deleting the names of
people who may still be around is worse.

How it attaches without a rebuild (see SPIKE-dm-aliases.md, "Как мы правим
element-web"):

  * Room title. matrix-js-sdk v44 keeps the computed name in Room.name, an OWN
    property recomputed by Room.recalculate() -> Room.calculateRoomName(). The
    hook is therefore the prototype method, reached through
    `window.mxMatrixClientPeg`. The room list tile, the room header, the tab
    title and toasts all read Room.name, so they follow without DOM rewriting.
    getDefaultRoomName() asks with ignoreRoomNameEvent=true and stays stock.
  * Author line. element-web renders a sender from a RoomMember: its
    `rawDisplayName` (the profile under a message) and its `name` (previews,
    exports, member lists). Both are own properties written by
    RoomMember.setMembershipEvent(), so the overlay wraps that method once and
    rewrites the two fields on the DM partner; the SDK's own values are kept
    aside and put back the moment the personal name goes away, so a reset
    returns the person's real display name — including a change they made
    themselves while the personal name was set.
  * Live repaint. Room.recalculate() emits Room.name for the title surfaces.
    Message tiles are React class components whose shouldComponentUpdate
    compares props and a display name is not a prop, so the overlay emits the
    event-level "this tile's body is stale, re-render it" signal that the tile
    already listens to (the same one element-web uses after an edit) for the
    events in the open room. No DOM patching, no fighting React: the tile
    re-renders against the member objects rewritten above, and stays correct
    through every later render.

Only personal dialogues get a personal name: a room is a DM when m.direct lists
it, or when it has exactly two joined members (how Element itself presents a
one-to-one chat). In a group room the partner is null, so no name is resolved
and no member is rewritten — a personal name can never mask a group's own name
or its members' display names.

Room ids: "!localpart:server" (room versions up to 11) and the opaque
"!<base64url>" of room version 12 have nothing in common but the leading "!".
Synapse creates v12 rooms by default since 1.162, so production DMs are opaque
and any format rule stricter than "starts with !, no whitespace or slash"
silently hides the feature (the QA defect). Which room a request belongs to is
therefore checked against the room data — the room object of this client and its
m.direct/member list — not against an id shape.

Reset writes the map without the key, and every write is sanitised, so the
stored object never carries empty values: removing the last name leaves {}.

Test handle: window.plotinaDmAliases exposes the name map plus
setName/clearName/names/nameForRoom/partnerOf/refresh so QA can drive the same
code path the dialog uses. Invalid ids and non-DM rooms reject with a coded
Error and a visible banner, never silence.
*/
(function (root) {
  "use strict";

  var ACCOUNT_DATA_TYPE = "cc.plotina.contact_names";
  // The room-keyed map an earlier build wrote. Named so the code and its tests
  // can say out loud that it is not read; nothing migrates it.
  var LEGACY_ACCOUNT_DATA_TYPE = "cc.plotina.room_aliases";
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

  /**
   * A Matrix user id is "@localpart:server". Only used to keep junk out of the
   * name map: a room id, an alias or a half-written key is not a contact.
   */
  function isUserId(id) {
    if (typeof id !== "string" || id !== id.trim()) return false;
    if (id.length < 4 || id.charAt(0) !== "@") return false;
    if (/[\s\/]/.test(id)) return false;
    var colon = id.indexOf(":");
    return colon > 1 && colon < id.length - 1;
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
      hint: "Only you see this. Everyone else still sees the room's own name.",
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
    var lang = ((typeof document !== "undefined" && document.documentElement &&
      document.documentElement.lang) || (typeof navigator !== "undefined" && navigator.language) || "")
      .toLowerCase();
    return lang.indexOf("ru") === 0 ? STRINGS.ru : STRINGS.en;
  }

  var state = {
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

  function ownUserId(c) {
    try {
      return (c && typeof c.getUserId === "function" && c.getUserId()) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Account data content -> {mxid: name}, strings only, trimmed.
   *
   * Tolerates a JSON string of the map (another client may have left one) and
   * every kind of junk: null, a list, a number, malformed JSON, a key that is
   * not an mxid, a blank or non-string value. Junk is skipped, never thrown, so
   * a corrupt account-data event cannot stop the client from rendering.
   */
  function parseNames(content) {
    var out = {};
    var raw = content;
    if (typeof raw === "string") {
      if (!raw.trim()) return out;
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        return out;
      }
    }
    if (!raw || typeof raw !== "object" || Object.prototype.toString.call(raw) === "[object Array]") {
      return out;
    }
    Object.keys(raw).forEach(function (userId) {
      var value = raw[userId];
      if (typeof value !== "string" || !value.trim()) return;
      if (!isUserId(userId)) {
        warnOnce(userId);
        return;
      }
      out[userId] = value.trim();
    });
    return out;
  }

  // A payload from a buggy version or another client must not spam the console
  // on every sync; report each dropped key once, loudly enough to be visible in
  // the client log as the "why is my name gone" trace.
  var warnedKeys = {};
  function warnOnce(userId) {
    if (warnedKeys[userId] || typeof console === "undefined" || !console.warn) return;
    warnedKeys[userId] = true;
    console.warn("[plotina-dm-aliases] ignoring a personal name whose key is not " +
      "an mxid: " + JSON.stringify(userId));
  }

  /** Immutable update: a copy of *map* with one contact named or unnamed. */
  function withName(map, userId, name) {
    var next = {};
    Object.keys(map || {}).forEach(function (key) {
      next[key] = map[key];
    });
    if (!isUserId(userId)) return next;
    var wanted = name === undefined || name === null ? "" : String(name).trim();
    if (wanted) next[userId] = wanted;
    else delete next[userId];
    return next;
  }

  /**
   * The name the overlay shows for a contact, or null for "keep the real one".
   * Pure: a personal name only applies inside a personal dialogue, so a contact
   * who is also in a group can never mask anything there.
   */
  function contactNameFor(map, userId, direct) {
    if (!direct || !userId) return null;
    var value = map && map[userId];
    if (typeof value !== "string") return null;
    value = value.trim();
    return value || null;
  }

  /**
   * Why a change request must be refused, or null when it may go ahead.
   * Pure, so the node tests pin both id shapes (v12 opaque included), the
   * DM-only rule and the contact it resolves to, without a browser. Clearing
   * (blank name) is only checked for the id: a stale name must stay removable
   * even when the room is gone from this client.
   */
  function nameRejection(roomId, name, room) {
    if (!isRoomId(roomId)) return "invalid_room_id";
    var wanted = String(name === undefined || name === null ? "" : name).trim();
    if (!wanted) return null;
    if (!room || !room.known) return "unknown_room";
    if (!room.direct || !isUserId(room.partner)) return "not_direct";
    return null;
  }

  function codedError(code) {
    var err = new Error(code);
    err.code = code;
    return err;
  }

  /* --------------------------------------------------------------- SDK hooks */

  /**
   * Wrap Room.prototype.calculateRoomName once. The personal name is supplied
   * per room by *resolve*, so the hook itself is testable with a fake proto.
   * ignoreRoomNameEvent=true is getDefaultRoomName()'s call and stays stock.
   */
  function installNameHook(proto, resolve) {
    if (!proto || typeof proto.calculateRoomName !== "function") return false;
    if (proto.__plotinaContactNames) return true;
    var original = proto.calculateRoomName;
    proto.calculateRoomName = function (userId, ignoreRoomNameEvent) {
      if (!ignoreRoomNameEvent) {
        var name = resolve(this.roomId);
        if (name) return name;
      }
      return original.apply(this, arguments);
    };
    proto.__plotinaContactNames = true;
    return true;
  }

  /**
   * Rewrite a RoomMember's name, keeping the SDK's own value aside.
   *
   * RoomMember.name and .rawDisplayName are plain own properties that
   * setMembershipEvent() writes from the membership event, so they can be
   * rewritten in place. What the SDK wrote is remembered per member object; if
   * something else writes that member later (a sync, a profile change), the new
   * value becomes the stock one, which is how a reset returns the person's
   * current real display name rather than the one from before the rename.
   *
   * name=null/"" restores the stock value. Returns true when the member was
   * touched. A member object without the fields is still handled (they stay
   * undefined on restore).
   */
  var memberStock = typeof WeakMap === "function" ? new WeakMap() : null;
  function applyMemberName(member, name) {
    if (!member || typeof member !== "object") return false;
    if (!memberStock) return false;
    var record = memberStock.get(member);
    var wanted = name === undefined || name === null ? "" : String(name).trim();
    if (!record) {
      record = { stock: { name: member.name, raw: member.rawDisplayName }, applied: null };
      memberStock.set(member, record);
    } else if (member.name !== record.applied) {
      record.stock = { name: member.name, raw: member.rawDisplayName };
      record.applied = null;
    }
    if (wanted) {
      member.name = wanted;
      member.rawDisplayName = wanted;
      record.applied = wanted;
    } else {
      member.name = record.stock.name;
      member.rawDisplayName = record.stock.raw;
      record.applied = null;
    }
    return true;
  }

  /**
   * Wrap RoomMember.prototype.setMembershipEvent once, so a member the SDK
   * rewrites after a sync keeps the personal name. *resolve* answers with the
   * name for a member, or null.
   */
  function installMemberHook(proto, resolve) {
    if (!proto || typeof proto.setMembershipEvent !== "function") return false;
    if (proto.__plotinaContactNames) return true;
    var original = proto.setMembershipEvent;
    proto.setMembershipEvent = function () {
      var result = original.apply(this, arguments);
      try {
        applyMemberName(this, resolve(this));
      } catch (e) {
        /* one broken member must not break the sync */
      }
      return result;
    };
    proto.__plotinaContactNames = true;
    return true;
  }

  /* ---------------------------------------------------------- DM detection */

  /** m.direct content -> {room_id: user_id}; only room ids and mxids are kept. */
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
  function joinedMemberIds(room) {
    if (!room) return null;
    try {
      if (typeof room.getJoinedMembers === "function") {
        var members = room.getJoinedMembers();
        if (Array.isArray(members)) {
          return members.map(function (m) { return m && m.userId; }).filter(Boolean);
        }
      }
      if (typeof room.getJoinedMemberCount === "function" && room.getJoinedMemberCount() !== 2) {
        return null;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /* ---------------------------------------------------------------- engine */

  /**
   * The storage + resolution model, with the Matrix client injected.
   *
   * Split out from the page wiring so the whole model — reading, resolving,
   * writing, refusing — is exercised by node tests against a fake client
   * without a browser.
   */
  function createEngine(options) {
    var opts = options || {};
    var engine = {
      client: opts.client || null,
      names: {},
      direct: {},
      repaint: typeof opts.repaint === "function" ? opts.repaint : null,
    };

    engine.client_ = function () {
      return engine.client || client();
    };

    /** The contact a room is a personal dialogue with, or null. */
    engine.partnerOf = function (roomId) {
      var c = engine.client_();
      if (!isRoomId(roomId) || !c) return null;
      var me = ownUserId(c);
      var fromDirect = engine.direct[roomId];
      if (isUserId(fromDirect) && fromDirect !== me) return fromDirect;
      var room = typeof c.getRoom === "function" ? c.getRoom(roomId) : null;
      var ids = joinedMemberIds(room);
      if (!ids || ids.length !== 2) return null;
      var others = ids.filter(function (id) { return id && id !== me; });
      return others.length === 1 ? others[0] : null;
    };

    /** The name shown for a room, or null for the room's own. */
    engine.nameForRoom = function (roomId) {
      var partner = engine.partnerOf(roomId);
      return contactNameFor(engine.names, partner, !!partner);
    };

    /** What the client knows about a room, for nameRejection(). */
    engine.roomState = function (roomId) {
      var c = engine.client_();
      var room = c && typeof c.getRoom === "function" ? c.getRoom(roomId) : null;
      var partner = engine.partnerOf(roomId);
      return { known: !!(room || engine.direct[roomId]), direct: !!partner, partner: partner };
    };

    /** Re-read m.direct and the name map, then apply them. */
    engine.refresh = function () {
      var c = engine.client_();
      if (!c) return {};
      var content = null;
      try {
        var event = typeof c.getAccountData === "function" ? c.getAccountData(ACCOUNT_DATA_TYPE) : null;
        content = event && typeof event.getContent === "function" ? event.getContent() : null;
      } catch (e) {
        content = null; // a broken event means "no names", never a crash
      }
      engine.direct = readDirectRooms(c);
      engine.apply(parseNames(content));
      return engine.names;
    };

    /** Swap the name map in, then rewrite members and repaint. */
    engine.apply = function (names) {
      engine.names = names || {};
      var c = engine.client_();
      if (!c) return;
      engine.direct = readDirectRooms(c);
      engine.install(c);
      engine.applyToMembers(c);
      if (engine.repaint) {
        try {
          engine.repaint(c);
        } catch (e) {
          /* a repaint failure is cosmetic; it must never break a write */
        }
      }
    };

    /**
     * Rewrite every member the names apply to, and nobody else.
     *
     * A member of a group room — or of a DM whose partner has no personal name —
     * gets null, which restores the stock value. So leaving a DM, or removing a
     * name, can never leave a masked member behind.
     */
    engine.applyToMembers = function (c) {
      var rooms = typeof c.getRooms === "function" ? c.getRooms() : [];
      for (var i = 0; i < rooms.length; i++) {
        var room = rooms[i];
        if (!room || !isRoomId(room.roomId)) continue;
        var partner = engine.partnerOf(room.roomId);
        var name = contactNameFor(engine.names, partner, !!partner);
        var members = null;
        try {
          members = room.currentState && room.currentState.members;
        } catch (e) {
          members = null;
        }
        if (members) {
          Object.keys(members).forEach(function (userId) {
            try {
              applyMemberName(members[userId], partner && userId === partner ? name : null);
            } catch (e) {
              /* one broken member must not stop the rest */
            }
          });
        }
        if (typeof room.recalculate === "function") {
          try {
            room.recalculate(); // emits Room.name when the display name changed
          } catch (e) {
            /* one broken room must not stop the others */
          }
        }
      }
    };

    /** Install both prototype hooks for this client, once. */
    engine.install = function (c) {
      var rooms = typeof c.getRooms === "function" ? c.getRooms() : [];
      var roomProto = rooms.length ? Object.getPrototypeOf(rooms[0]) : null;
      var nameHook = roomProto && installNameHook(roomProto, function (roomId) {
        return engine.nameForRoom(roomId);
      });
      var memberProto = null;
      for (var i = 0; i < rooms.length && !memberProto; i++) {
        var members = rooms[i] && rooms[i].currentState && rooms[i].currentState.members;
        var first = members && Object.keys(members)[0];
        if (first) memberProto = Object.getPrototypeOf(members[first]);
      }
      var memberHook = memberProto && installMemberHook(memberProto, function (member) {
        var partner = member && engine.partnerOf(member.roomId);
        if (!partner || partner !== member.userId) return null;
        return contactNameFor(engine.names, partner, true);
      });
      if (nameHook || memberHook) state.patched = true;
      return !!(nameHook && memberHook);
    };

    /**
     * Write the sanitised map, never the caller's object: blank labels and keys
     * that are not mxids must not reach the server, and removing the last name
     * writes {} with no empty values.
     */
    engine.write = function (next) {
      var c = engine.client_();
      if (!c) return Promise.reject(new Error("no Matrix client yet"));
      var clean = parseNames(next);
      return c.setAccountData(ACCOUNT_DATA_TYPE, clean).then(function () {
        // Apply locally at once; the accountData sync event re-reads the same
        // map, so this is idempotent rather than racy.
        engine.apply(clean);
        return engine.names;
      });
    };

    /** Name the person behind *roomId*; blank *name* resets it. */
    engine.setName = function (roomId, name) {
      var rejection = nameRejection(roomId, name, engine.roomState(roomId));
      if (rejection) return Promise.reject(codedError(rejection));
      var partner = engine.partnerOf(roomId);
      if (!partner) return Promise.reject(codedError("not_direct"));
      return engine.write(withName(engine.names, partner, name));
    };

    /**
     * Reset the name of the person behind *roomId*.
     *
     * Resetting has to work even when the room is gone from this client (a
     * stale name must always be removable), so a missing partner is a no-op
     * rather than a refusal — the key is addressed by contact, not by room.
     */
    engine.clearName = function (roomId) {
      if (!isRoomId(roomId)) return Promise.reject(codedError("invalid_room_id"));
      var partner = engine.partnerOf(roomId);
      if (!partner) return Promise.resolve(engine.names);
      return engine.write(withName(engine.names, partner, ""));
    };

    return engine;
  }

  /* ------------------------------------------------------------ page wiring */

  /**
   * Repaint the open room: the title surfaces listen to the room, the message
   * tiles and the room-list preview listen to their events.
   *
   * A display name is not a React prop, so the tiles need the "this tile's body
   * is stale" signal they already handle — the same one element-web emits after
   * an edit. They then re-render against the member objects already rewritten
   * above. The room-list preview is a store value generated from the last
   * events, so it is refreshed by the action element-web dispatches for a live
   * timeline event; that makes the store recompute the text (and read the new
   * name) instead of showing the old one until the next message arrives.
   */
  function repaintRoom(c) {
    var hash = typeof location !== "undefined" ? location.hash || "" : "";
    var open = hash.indexOf("#/room/") === 0 ?
      decodeURIComponent(hash.slice("#/room/".length).split("/")[0].split("?")[0]) : null;
    var rooms = typeof c.getRooms === "function" ? c.getRooms() : [];
    for (var i = 0; i < rooms.length; i++) {
      var room = rooms[i];
      if (!room) continue;
      if (typeof room.recalculate === "function") {
        try {
          room.recalculate();
        } catch (e) {
          /* ignore */
        }
      }
      if (!open || room.roomId !== open) continue;
      var events = [];
      try {
        events = room.getLiveTimeline().getEvents();
      } catch (e) {
        events = [];
      }
      for (var j = 0; j < events.length; j++) {
        var event = events[j];
        if (!event || typeof event.emit !== "function") continue;
        try {
          // MatrixEventEvent.Replaced: "the body of this tile is stale".
          event.emit("Event.replaced", event);
        } catch (e) {
          /* one stubborn tile is not a reason to stop */
        }
      }
      refreshRoomListPreview(room, events);
    }
  }

  /**
   * Ask the message-preview store to recompute this room's preview.
   *
   * The store keeps the preview text per room and only regenerates it when a
   * live timeline event is dispatched, so a rename alone would leave the old
   * name in the room list until the next message. The payload is the one
   * element-web itself dispatches for a live event; if the dispatcher or the
   * action is not there (a future renderer), the preview simply refreshes on
   * the next message, as it did before.
   */
  function refreshRoomListPreview(room, events) {
    var dispatcher = root.mxDispatcher;
    if (!dispatcher || typeof dispatcher.dispatch !== "function") return;
    var last = events && events.length ? events[events.length - 1] : null;
    if (!last) return;
    try {
      dispatcher.dispatch({
        action: "MatrixActions.Room.timeline",
        event: last,
        room: room,
        isLiveEvent: true,
        isLiveUnfilteredRoomTimelineEvent: true,
      });
    } catch (e) {
      /* the preview is cosmetic here; never let it break a rename */
    }
  }

  var engine = createEngine({ repaint: repaintRoom });

  /** Coded error with the human-facing message the dialog shows. */
  function uiError(code, roomId) {
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

  function setName(roomId, name) {
    return engine.setName(roomId, name).then(function (next) {
      return next;
    }, function (rejection) {
      var code = rejection && rejection.code;
      if (!code) throw rejection;
      // The QA defect was a silent no-op: the write went through and nothing
      // changed on screen. A refused write now says why, in a banner, and still
      // rejects so callers (the test handle) see it.
      var err = uiError(code, roomId);
      showError(err.message);
      throw err;
    });
  }

  function clearName(roomId) {
    return setName(roomId, "");
  }

  function refresh() {
    return engine.refresh();
  }

  function attach(c) {
    if (!c || c.__plotinaDmAliasesAttached) return;
    c.__plotinaDmAliasesAttached = true;
    state.client = c;
    engine.client = c;

    engine.refresh();

    // A room created after startup inherits the patched prototypes, but its
    // first name was computed before the patch could see it in some orders;
    // recalculate on arrival so the personal name wins either way.
    if (typeof c.on === "function") {
      c.on("Room", function (room) {
        engine.install(c);
        engine.applyToMembers(c);
        if (room && typeof room.recalculate === "function") {
          try {
            room.recalculate();
          } catch (e) {
            /* ignore */
          }
        }
      });
      c.on("RoomState.members", function () {
        // A member arrived or changed. The member hook renamed it already, but
        // the tiles may still be showing the previous object.
        repaintRoom(c);
      });
      c.on("accountData", function (event) {
        if (!event || typeof event.getType !== "function") return;
        var type = event.getType();
        if (type === ACCOUNT_DATA_TYPE) {
          engine.apply(parseNames(event.getContent ? event.getContent() : null));
        } else if (type === DIRECT_EVENT_TYPE) {
          // A room that just became (or stopped being) a DM changes whether a
          // personal name applies at all; re-read m.direct and repaint.
          engine.apply(engine.names);
        }
      });
      c.on("sync", function (syncState) {
        if (syncState === "PREPARED" || syncState === "SYNCING") {
          // The first sync is where both the rooms and the account data
          // arrive; reading again costs nothing on later ones.
          engine.refresh();
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
    // then login without a reload). The name map and the prototype patches
    // belong to whatever client object is current, so follow it.
    root.setInterval(function () {
      var current = client();
      if (current && current !== state.client) {
        state.patched = false;
        engine.client = current;
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
    // The personal name is a dialogue feature (QA finding): no pencil on a
    // group room, where the name belongs to the room and to everyone in it.
    if (!roomId || !engine.partnerOf(roomId)) {
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
    if (!engine.partnerOf(roomId)) {
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
      input.value = engine.nameForRoom(state.dialogRoomId) || "";
    }
  }

  function saveFromDialog(value) {
    var roomId = state.dialogRoomId;
    if (!roomId) return;
    var status = document.querySelector("#plotina-dm-alias-dialog .plotina-alias-status");
    setName(roomId, value).then(function () {
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
    LEGACY_ACCOUNT_DATA_TYPE: LEGACY_ACCOUNT_DATA_TYPE,
    ready: function () {
      return !!(state.client && state.patched);
    },
    /** The contact map: {mxid: name}. */
    names: function () {
      return engine.names;
    },
    /** The personal name shown for a room, or null. */
    nameForRoom: function (roomId) {
      return engine.nameForRoom(roomId);
    },
    /** The mxid this room is a personal dialogue with, or null. */
    partnerOf: function (roomId) {
      return engine.partnerOf(roomId);
    },
    /** Is the given room a DM for this account (m.direct or 2 members)? */
    isDirect: function (roomId) {
      return !!engine.partnerOf(roomId);
    },
    refresh: refresh,
    setName: setName,
    clearName: clearName,
  };

  /* ------------------------------------------------------------ node tests */

  // CommonJS export for element-web/tests/contact_names.test.js: the pure
  // pieces and the engine factory only. node has no DOM and no Matrix client,
  // so the browser entry point below is skipped there (branding_test.py wires
  // the test into the suite).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      ACCOUNT_DATA_TYPE: ACCOUNT_DATA_TYPE,
      LEGACY_ACCOUNT_DATA_TYPE: LEGACY_ACCOUNT_DATA_TYPE,
      DIRECT_EVENT_TYPE: DIRECT_EVENT_TYPE,
      isRoomId: isRoomId,
      isUserId: isUserId,
      parseNames: parseNames,
      withName: withName,
      contactNameFor: contactNameFor,
      nameRejection: nameRejection,
      installNameHook: installNameHook,
      installMemberHook: installMemberHook,
      applyMemberName: applyMemberName,
      createEngine: createEngine,
    };
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof window !== "undefined" ? window : this);
