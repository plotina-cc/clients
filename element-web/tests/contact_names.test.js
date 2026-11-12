// Node tests for plotina-dm-aliases.js — run with:
//   node element-web/tests/contact_names.test.js element-web/plotina-dm-aliases.js
// (branding_test.py wires this into element-web/tests/run.sh's unittest suite)
//
// The overlay used to store a personal name per ROOM (cc.plotina.room_aliases,
// keyed by room id). It now stores one name per CONTACT (cc.plotina.contact_names,
// keyed by the participant's MXID), so the same person carries one name across
// all of their direct chats — like any messenger's contact name.
//
// Covered here, without a browser and without a real SDK:
//   * the pure map handling (sanitising junk, immutable updates, reset that
//     removes the key instead of writing "");
//   * the room -> contact link (m.direct first, then a two-person room) and the
//     DM-only rule, for both room id shapes (v<=11 "!localpart:server" and the
//     v12 opaque "!<base64url>");
//   * the same person in two different DMs (one name, both rooms);
//   * a name that must NOT leak into a group room where that person is a member;
//   * the Room.name hook and the RoomMember name hook (author line), including
//     the stock value coming back on reset;
//   * the account-data contract: a rename writes exactly one PUT of
//     cc.plotina.contact_names and nothing else (no state events, no to-device,
//     no event deletion);
//   * the legacy cc.plotina.room_aliases event is neither read nor migrated.
//
// The browser and the real SDK are covered end-to-end by
// spike-dm-aliases/proof-contact-names.mjs against a real v12 Synapse.
"use strict";

const assert = require("node:assert/strict");
const nodePath = require("node:path");
const fs = require("node:fs");

const overlay = require(nodePath.resolve(process.argv[2]));
const {
  ACCOUNT_DATA_TYPE,
  LEGACY_ACCOUNT_DATA_TYPE,
  DIRECT_EVENT_TYPE,
  isUserId,
  isRoomId,
  parseNames,
  withName,
  contactNameFor,
  nameRejection,
  installNameHook,
  applyMemberName,
  createEngine,
} = overlay;

let passed = 0;
const failures = [];
// The tests that touch the engine are async, and this file is CommonJS (no
// top-level await), so they are queued and awaited in order; the summary and the
// exit code come after the last one.
let queue = Promise.resolve();
function test(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      passed++;
      console.log("PASS: " + name);
    } catch (e) {
      failures.push(name + " :: " + (e && e.stack ? e.stack.split("\n")[0] : e));
      console.log("FAIL: " + name + " :: " + (e && e.message ? e.message : e));
    }
  });
}

// Room ids as Synapse hands them out: v11 carries a server part, v12 (default
// since Synapse 1.162) is opaque, base64url, with no colon at all.
const V11 = "!i2kHEuNKioA9a0Xrkn:spike.local";
const V12 = "!SXCZ-1RDqc_JxejRKA17NoOqnAUk2TuB9bBy9GMTIuo";
const ME = "@alice:example.org";
const BOB = "@bob:example.org";
const CAROL = "@carol:example.org";

/* ------------------------------------------------------------- fake client */

function fakeClient(options) {
  const opts = options || {};
  const accountData = new Map(Object.entries(opts.accountData || {}));
  const rooms = opts.rooms || {};
  const calls = [];
  const client = {
    calls,
    getUserId: () => opts.userId || ME,
    getAccountData(type) {
      if (!accountData.has(type)) return undefined;
      const content = accountData.get(type);
      return {
        getType: () => type,
        getContent: () => {
          if (opts.throwingContent === type) throw new Error("boom: broken account data");
          return content;
        },
      };
    },
    setAccountData(type, content) {
      calls.push({ method: "setAccountData", type, content });
      accountData.set(type, JSON.parse(JSON.stringify(content)));
      return Promise.resolve({});
    },
    getRoom: (id) => rooms[id] || null,
    getRooms: () => Object.values(rooms),
    on: () => {},
    off: () => {},
    emit: () => {},
    // Anything below must stay untouched by the overlay. Each one both records
    // the call and throws, so a test fails with the offending call named.
    sendStateEvent(...args) {
      calls.push({ method: "sendStateEvent", args });
      throw new Error("the overlay must not send room state");
    },
    sendEvent(...args) {
      calls.push({ method: "sendEvent", args });
      throw new Error("the overlay must not send room events");
    },
    sendToDevice(...args) {
      calls.push({ method: "sendToDevice", args });
      throw new Error("the overlay must not write other users' data");
    },
    deleteAccountData(...args) {
      calls.push({ method: "deleteAccountData", args });
      throw new Error("the overlay must not delete account data");
    },
  };
  return client;
}

function fakeRoom(roomId, userIds, members, extra) {
  const room = {
    roomId,
    getJoinedMemberCount: () => (userIds ? userIds.length : 0),
    getJoinedMembers: () => (userIds || []).map((userId) => members && members[userId] ?
      members[userId] : { userId }),
    getMember: (userId) => (members && members[userId]) || null,
  };
  return Object.assign(room, extra || {});
}

function fakeMember(userId, name) {
  return { userId, name, rawDisplayName: name, roomId: V12, disambiguate: false };
}

const DM_ROOMS = () => {
  const bob = fakeMember(BOB, "Даниил");
  const me = fakeMember(ME, "Алиса");
  return {
    [V12]: fakeRoom(V12, [ME, BOB], { [ME]: me, [BOB]: bob }),
    [V11]: fakeRoom(V11, [ME, BOB], { [ME]: me, [BOB]: bob }),
  };
};

function accountDataCalls(client) {
  return client.calls.filter((c) => c.method !== "setAccountData" || c.type !== ACCOUNT_DATA_TYPE);
}

/* ------------------------------------------------------------------- types */

test("account data type is the contact one", () => {
  assert.equal(ACCOUNT_DATA_TYPE, "cc.plotina.contact_names");
});

test("the legacy room-keyed type is still named, so it can be recognised", () => {
  assert.equal(LEGACY_ACCOUNT_DATA_TYPE, "cc.plotina.room_aliases");
  assert.equal(DIRECT_EVENT_TYPE, "m.direct");
});

/* ---------------------------------------------------------------- id shapes */

test("accepts room ids of both shapes (v12 opaque has no colon)", () => {
  assert.equal(isRoomId(V11), true);
  assert.equal(isRoomId(V12), true);
  for (const bad of ["", "!", "plain", "@user:example.org", "!has space", "!a/b", 42, null]) {
    assert.equal(isRoomId(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("accepts user ids of the mxid shape only", () => {
  for (const good of [ME, BOB, "@a:b", "@localpart:server.example.org"]) {
    assert.equal(isUserId(good), true, `rejected ${good}`);
  }
  for (const bad of ["", "@", "@:server", "@nocolon", "!room:example.org", "#alias:example.org",
    "@user:", "plain", " @a:b", 42, null, undefined, {}]) {
    assert.equal(isUserId(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

/* ------------------------------------------------------------- map handling */

test("reads an mxid -> name map", () => {
  const content = { [BOB]: "Денчик", [CAROL]: "Мама" };
  assert.deepEqual(parseNames(content), content);
});

test("trims names and drops empty or non-string values", () => {
  const out = parseNames({
    [BOB]: "  Денчик  ",
    [CAROL]: "   ",
    "@empty:example.org": "",
    "@num:example.org": 42,
    "@null:example.org": null,
    "@obj:example.org": { name: "x" },
  });
  assert.deepEqual(out, { [BOB]: "Денчик" });
});

test("drops keys that are not user ids (a room id is not a contact)", () => {
  const out = parseNames({
    [BOB]: "Денчик",
    [V12]: "не контакт",
    "plain": "nope",
    "": "empty key",
  });
  assert.deepEqual(out, { [BOB]: "Денчик" });
});

test("tolerates null, undefined and non-object content", () => {
  for (const bad of [null, undefined, "", 7, [], true]) {
    assert.deepEqual(parseNames(bad), {}, `content ${JSON.stringify(bad)}`);
  }
  // A JSON string is what some other client may have left behind; parse it
  // rather than losing the names, but never throw on malformed JSON.
  assert.deepEqual(parseNames(JSON.stringify({ [BOB]: "Денчик" })), { [BOB]: "Денчик" });
  assert.deepEqual(parseNames("{not json"), {});
});

test("withName sets, trims and leaves the input map alone", () => {
  const before = { [CAROL]: "one" };
  const next = withName(before, BOB, "  два  ");
  assert.deepEqual(next, { [CAROL]: "one", [BOB]: "два" });
  assert.deepEqual(before, { [CAROL]: "one" });
});

test("withName removes on empty or blank and never mutates", () => {
  const before = { [BOB]: "one", [CAROL]: "two" };
  for (const empty of ["", "   ", null, undefined]) {
    assert.deepEqual(withName(before, BOB, empty), { [CAROL]: "two" });
  }
  assert.deepEqual(before, { [BOB]: "one", [CAROL]: "two" });
  assert.deepEqual(withName(undefined, BOB, "Денчик"), { [BOB]: "Денчик" });
});

test("withName refuses a key that is not an mxid", () => {
  assert.deepEqual(withName({ [BOB]: "one" }, V12, "x"), { [BOB]: "one" });
});

test("contactNameFor answers only for direct chats", () => {
  const map = { [BOB]: "Денчик", [CAROL]: "Мама" };
  assert.equal(contactNameFor(map, BOB, true), "Денчик");
  assert.equal(contactNameFor(map, BOB, false), null, "a group chat must keep its own names");
  assert.equal(contactNameFor(map, CAROL, true), "Мама");
  assert.equal(contactNameFor(map, "@nobody:example.org", true), null);
  assert.equal(contactNameFor({ [BOB]: "  " }, BOB, true), null);
  assert.equal(contactNameFor(null, BOB, true), null);
  assert.equal(contactNameFor(map, null, true), null);
});

/* ------------------------------------------------------------- account data */

test("a rename in one DM writes one PUT of the contact map, nothing else", async () => {
  const client = fakeClient({ rooms: DM_ROOMS() });
  const engine = createEngine({ client });
  engine.refresh();
  await engine.setName(V12, "Денчик");

  const writes = client.calls.filter((c) => c.method === "setAccountData");
  assert.equal(writes.length, 1, "exactly one account-data write per rename");
  assert.equal(writes[0].type, ACCOUNT_DATA_TYPE);
  assert.deepEqual(writes[0].content, { [BOB]: "Денчик" });
  assert.deepEqual(accountDataCalls(client), [], "nothing but a PUT of the contact map");
});

test("reset removes the key and never writes an empty value", async () => {
  const client = fakeClient({ rooms: DM_ROOMS() });
  const engine = createEngine({ client });
  engine.refresh();
  await engine.setName(V12, "Денчик");
  await engine.clearName(V12);

  const writes = client.calls.filter((c) => c.method === "setAccountData");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].content, {}, "clearing the last name leaves {}");
  for (const value of Object.values(writes[1].content)) {
    assert.notEqual(String(value).trim(), "", "no empty values may reach the server");
  }
  assert.deepEqual(accountDataCalls(client), []);
});

test("reset of one contact leaves the others alone", async () => {
  const rooms = DM_ROOMS();
  rooms["!carol:example.org"] = fakeRoom("!carol:example.org", [ME, CAROL]);
  const client = fakeClient({ rooms, accountData: { [ACCOUNT_DATA_TYPE]: { [BOB]: "Денчик", [CAROL]: "Мама" } } });
  const engine = createEngine({ client });
  engine.refresh();
  await engine.clearName(V12);
  assert.deepEqual(engine.names, { [CAROL]: "Мама" });
  assert.equal(engine.nameForRoom("!carol:example.org"), "Мама");
});

/* --------------------------------------------------- the same person, two DMs */

test("one contact name is visible in both DMs with the same person", async () => {
  const rooms = DM_ROOMS();
  const client = fakeClient({ rooms });
  const engine = createEngine({ client });
  engine.refresh();

  assert.equal(engine.partnerOf(V12), BOB);
  assert.equal(engine.partnerOf(V11), BOB, "both rooms resolve to the same contact");

  await engine.setName(V12, "Денчик");
  assert.equal(engine.nameForRoom(V12), "Денчик");
  assert.equal(engine.nameForRoom(V11), "Денчик", "the name set in one DM shows in the other");
});

test("a rename in the second DM replaces the same contact name", async () => {
  const client = fakeClient({ rooms: DM_ROOMS() });
  const engine = createEngine({ client });
  engine.refresh();
  await engine.setName(V12, "Денчик");
  await engine.setName(V11, "Даниил");
  assert.equal(engine.nameForRoom(V12), "Даниил");
  assert.deepEqual(engine.names, { [BOB]: "Даниил" }, "one key per person, not one per room");
});

/* ------------------------------------------------------------ group guard */

test("a contact name does not leak into a group room", async () => {
  const rooms = DM_ROOMS();
  const GROUP = "!x1bjMrsUU-PgPMGjzJh-f6IWkIdY-M6L7c7g4SI6Q2Q";
  rooms[GROUP] = fakeRoom(GROUP, [ME, BOB, CAROL]);
  const client = fakeClient({ rooms });
  const engine = createEngine({ client });
  engine.refresh();
  await engine.setName(V12, "Денчик");

  assert.equal(engine.partnerOf(GROUP), null);
  assert.equal(engine.nameForRoom(GROUP), null, "a group keeps its own name");
});

test("a group room cannot be given a contact name", async () => {
  const rooms = DM_ROOMS();
  const GROUP = "!x1bjMrsUU-PgPMGjzJh-f6IWkIdY-M6L7c7g4SI6Q2Q";
  rooms[GROUP] = fakeRoom(GROUP, [ME, BOB, CAROL]);
  const client = fakeClient({ rooms });
  const engine = createEngine({ client });
  engine.refresh();
  await assert.rejects(engine.setName(GROUP, "Денчик"), (err) => err.code === "not_direct");
  assert.deepEqual(client.calls, [], "a refused write reaches the network not at all");
});

test("malformed ids are refused; clearing is always allowed", async () => {
  const client = fakeClient({ rooms: DM_ROOMS() });
  const engine = createEngine({ client });
  engine.refresh();
  await assert.rejects(engine.setName("not a room id", "x"), (err) => err.code === "invalid_room_id");
  await assert.rejects(engine.setName("!unknown:example.org", "x"), (err) => err.code === "unknown_room");
  // A stale name must stay removable even when the room is gone from the client.
  await engine.clearName("!unknown:example.org");
  assert.deepEqual(accountDataCalls(client), []);
});

test("nameRejection is the documented matrix of refusals", () => {
  assert.equal(nameRejection(V12, "Денчик", { known: true, direct: true, partner: BOB }), null);
  assert.equal(nameRejection(V12, "Денчик", { known: true, direct: false, partner: null }), "not_direct");
  assert.equal(nameRejection(V12, "", { known: true, direct: false, partner: null }), null,
    "a stale name must always be removable");
  assert.equal(nameRejection(V12, "x", { known: false, direct: false, partner: null }), "unknown_room");
  for (const bad of ["", "!", "@user:example.org", "plain", "!a b"]) {
    assert.equal(nameRejection(bad, "x", { known: true, direct: true, partner: BOB }), "invalid_room_id");
  }
});

/* ------------------------------------------------------------- junk input */

test("junk in account data never breaks the render", async () => {
  const junk = {
    "": "empty key",
    [V12]: "room id as a key",
    "@nocolon": "not an mxid",
    "@:empty": "no localpart",
    [BOB]: { nested: true },
    [CAROL]: "  ",
  };
  const client = fakeClient({ rooms: DM_ROOMS(), accountData: { [ACCOUNT_DATA_TYPE]: junk } });
  const engine = createEngine({ client });
  assert.deepEqual(engine.refresh(), {}, "nothing usable in the junk");
  assert.equal(engine.nameForRoom(V12), null);
  // And a following rename writes only clean data.
  await engine.setName(V12, "Денчик");
  assert.deepEqual(client.calls.filter((c) => c.method === "setAccountData")[0].content,
    { [BOB]: "Денчик" });
});

test("a broken account-data event is survivable", () => {
  const client = fakeClient({
    rooms: DM_ROOMS(),
    accountData: { [ACCOUNT_DATA_TYPE]: { [BOB]: "Денчик" } },
    throwingContent: ACCOUNT_DATA_TYPE,
  });
  const engine = createEngine({ client });
  assert.deepEqual(engine.refresh(), {});
  assert.equal(engine.nameForRoom(V12), null, "no name rather than a crash");
});

test("a broken room object is survivable", () => {
  const client = fakeClient({ rooms: { [V12]: { roomId: V12 } } });
  const engine = createEngine({ client });
  engine.refresh();
  assert.equal(engine.partnerOf(V12), null);
  assert.equal(engine.nameForRoom(V12), null);
});

test("the legacy room-keyed event is never read", async () => {
  const client = fakeClient({
    rooms: DM_ROOMS(),
    accountData: { [LEGACY_ACCOUNT_DATA_TYPE]: { [V12]: "Денчик" } },
  });
  const engine = createEngine({ client });
  assert.deepEqual(engine.refresh(), {}, "no migration: the old names are dropped");
  assert.equal(engine.nameForRoom(V12), null);
  assert.deepEqual(client.calls, [], "and nothing is written to 'migrate' them");
});

/* ---------------------------------------------------------------- SDK hooks */

test("installNameHook: Room.name takes the contact name in a DM", () => {
  class FakeRoom {
    constructor(roomId) { this.roomId = roomId; }
    calculateRoomName(userId, ignoreRoomNameEvent) {
      return "stock:" + this.roomId + (ignoreRoomNameEvent ? ":default" : "");
    }
  }
  const resolve = (roomId) => (roomId === V12 || roomId === V11 ? "Денчик" : null);
  assert.equal(installNameHook(FakeRoom.prototype, resolve), true);
  assert.equal(installNameHook(FakeRoom.prototype, resolve), true, "idempotent");
  const dm = new FakeRoom(V12);
  const group = new FakeRoom("!group:example.org");
  assert.equal(dm.calculateRoomName(ME), "Денчик");
  assert.equal(dm.calculateRoomName(ME, true), "stock:" + V12 + ":default",
    "getDefaultRoomName() must stay stock");
  assert.equal(group.calculateRoomName(ME), "stock:!group:example.org");
  assert.equal(installNameHook({}, resolve), false);
  assert.equal(installNameHook(null, resolve), false);
});

test("applyMemberName: the DM partner takes the name, everyone else keeps theirs", () => {
  const bob = fakeMember(BOB, "Даниил");
  const me = fakeMember(ME, "Алиса");
  applyMemberName(bob, "Денчик");
  assert.equal(bob.name, "Денчик");
  assert.equal(bob.rawDisplayName, "Денчик", "the author line reads rawDisplayName");
  applyMemberName(me, null);
  assert.equal(me.name, "Алиса");

  // Reset brings the stock value back, not an empty label.
  applyMemberName(bob, null);
  assert.equal(bob.name, "Даниил");
  assert.equal(bob.rawDisplayName, "Даниил");
});

test("applyMemberName follows a server-side rename after a reset", () => {
  const bob = fakeMember(BOB, "Даниил");
  applyMemberName(bob, "Денчик");
  applyMemberName(bob, null);
  // The other user changes their profile; the SDK rewrites the member.
  bob.name = "Даниил Петров";
  bob.rawDisplayName = "Даниил Петров";
  applyMemberName(bob, null);
  assert.equal(bob.name, "Даниил Петров");
  applyMemberName(bob, "Денчик");
  applyMemberName(bob, null);
  assert.equal(bob.name, "Даниил Петров", "the stock value is the latest real one");
});

test("applyMemberName tolerates a member without a stock value", () => {
  const member = { userId: BOB };
  applyMemberName(member, null);
  assert.equal(member.name, undefined);
  applyMemberName(member, "Денчик");
  assert.equal(member.name, "Денчик");
  applyMemberName(member, null);
  assert.equal(member.name, undefined);
});

/* ---------------------------------------------------------------- UI contract */

const source = fs.readFileSync(nodePath.resolve(process.argv[2]), "utf8");

test("the personal-name dialog has no placeholder text", () => {
  assert.equal(/placeholder/i.test(source), false,
    "no placeholder string and no input.placeholder assignment may stay");
});

test("the header pencil is anchored to the name row", () => {
  assert.match(source, /mx_RoomHeader_heading/);
  assert.match(source, /function insertAfterName/);
  assert.doesNotMatch(source, /info\.appendChild\(button\)/);
});

test("the overlay writes nothing but account data", () => {
  for (const forbidden of ["sendStateEvent", "sendEvent(", "sendToDevice", "deleteAccountData"]) {
    assert.equal(source.includes(forbidden), false,
      `${forbidden} must not appear in the overlay at all`);
  }
  assert.match(source, /setAccountData/);
});

queue.then(() => {
  console.log(failures.length ? "FAILED (" + failures.length + ")" : "ALL OK (" + passed + " tests)");
  if (failures.length) {
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
});
