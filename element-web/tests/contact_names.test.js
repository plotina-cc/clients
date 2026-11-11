// Node tests for plotina-dm-aliases.js — run with:
//   node element-web/tests/contact_names.test.js element-web/plotina-dm-aliases.js
// (branding_test.py wires this into element-web/tests' unittest suite)
//
// The contract under test is the shared one: account data
// `cc.plotina.contact_names` as {"<mxid>": "<name>"}. A personal name belongs
// to a CONTACT, so one person with two DMs carries the same name in both, and
// a group room never takes a contact's name.
//
// Covered here: the pure map handling, the mxid contract, the DM-partner
// resolution (m.direct first, then the two-member fallback, never the room id's
// shape) and the Room.name hook with a fake prototype.
"use strict";

const assert = require("node:assert/strict");
const nodePath = require("node:path");
const {
  ACCOUNT_DATA_TYPE,
  DIRECT_EVENT_TYPE,
  isUserId,
  parseContactNames,
  withContactName,
  contactNameFor,
  dmPartnerId,
  contactNameForRoom,
  installNameHook,
} = require(nodePath.resolve(process.argv[2]));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("PASS: " + name);
}

// Room ids as Synapse hands them out: v11 carries a server part, v12 (default
// since Synapse 1.162) is opaque, base64url, with no colon at all.
const V11 = "!i2kHEuNKioA9a0Xrkn:spike.local";
const V12 = "!aB3dEfGh1JkLmNoPqRsTuV";

const ME = "@alice:plotina.cc";
const BOB = "@bob:plotina.cc";
const CAROL = "@carol:plotina.cc";

test("account data type is the shared contact-names one", () => {
  assert.equal(ACCOUNT_DATA_TYPE, "cc.plotina.contact_names");
});

test("the old room-keyed event is not the contract any more", () => {
  assert.notEqual(ACCOUNT_DATA_TYPE, "cc.plotina.room_aliases");
});

test("m.direct is the DM account data type", () => {
  assert.equal(DIRECT_EVENT_TYPE, "m.direct");
});

test("accepts mxids", () => {
  assert.equal(isUserId(BOB), true);
  assert.equal(isUserId("@a:b"), true);
  assert.equal(isUserId("@u:example.org:8448"), true);
});

test("rejects things that are not mxids", () => {
  for (const bad of ["", "@", "@nocolon", "@:server", "@user:", "user:server",
    V11, V12, "#alias:example.org", "!room:example.org", "@has space:x",
    42, null, undefined, {}, []]) {
    assert.equal(isUserId(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("reads an mxid -> name map", () => {
  const content = { [BOB]: "Денчик", [CAROL]: "Мама" };
  assert.deepEqual(parseContactNames(content), content);
});

test("trims names and drops empty or non-string values", () => {
  const out = parseContactNames({
    [BOB]: "  Денчик  ",
    [CAROL]: "   ",
    "@num:example.org": 42,
    "@null:example.org": null,
    "@obj:example.org": { name: "x" },
  });
  assert.deepEqual(out, { [BOB]: "Денчик" });
});

test("ignores keys that are not mxids", () => {
  const out = parseContactNames({
    [BOB]: "Денчик",
    [V12]: "not a contact any more",
    "plain": "nope",
    "": "empty key",
  });
  assert.deepEqual(out, { [BOB]: "Денчик" });
});

test("tolerates null, undefined and non-object content", () => {
  for (const bad of [null, undefined, "", "text", 7, [], [[BOB, "x"]]]) {
    assert.deepEqual(parseContactNames(bad), {});
  }
});

// ------------------------------------------------------- DM partner by contact

test("m.direct names the partner, room id shape never matters", () => {
  // Both id shapes must work: v12 opaque ids are the production case.
  assert.equal(dmPartnerId(V11, ME, { [V11]: BOB }, [ME, BOB]), BOB);
  assert.equal(dmPartnerId(V12, ME, { [V12]: BOB }, [ME, BOB]), BOB);
});

test("a room m.direct does not list falls back to the two-member rule", () => {
  assert.equal(dmPartnerId(V12, ME, {}, [ME, BOB]), BOB);
  assert.equal(dmPartnerId(V12, ME, {}, [BOB, ME]), BOB);
});

test("a group room has no partner", () => {
  assert.equal(dmPartnerId(V12, ME, {}, [ME, BOB, CAROL]), null);
  assert.equal(dmPartnerId(V12, ME, {}, [ME]), null);
  assert.equal(dmPartnerId(V12, ME, {}, []), null);
  assert.equal(dmPartnerId(V12, ME, {}, null), null);
});

test("m.direct wins over the member count and is never myself", () => {
  // A DM whose member list has not arrived yet is still a DM by m.direct.
  assert.equal(dmPartnerId(V12, ME, { [V12]: BOB }, []), BOB);
  // A self-DM (m.direct pointing at me) is not a contact.
  assert.equal(dmPartnerId(V12, ME, { [V12]: ME }, [ME]), null);
});

test("(а) one person in two DMs carries one name in both", () => {
  const first = "!one:plotina.cc";
  const second = V12;
  const direct = { [first]: BOB, [second]: BOB };
  const names = { [BOB]: "Денчик" };
  const a = contactNameForRoom(names, first, ME, direct, [ME, BOB]);
  const b = contactNameForRoom(names, second, ME, direct, [ME, BOB]);
  assert.equal(a, "Денчик");
  assert.equal(b, "Денчик", "the name is bound to the contact, not the room");
});

test("(б) a contact name never leaks into a group", () => {
  const group = "!group:plotina.cc";
  const names = { [BOB]: "Денчик", [CAROL]: "Мама" };
  assert.equal(contactNameForRoom(names, group, ME, {}, [ME, BOB, CAROL]), null);
});

test("a DM without a personal name keeps the room's own name", () => {
  assert.equal(contactNameForRoom({ [CAROL]: "Мама" }, V12, ME, { [V12]: BOB }, [ME, BOB]), null);
  assert.equal(contactNameForRoom(null, V12, ME, { [V12]: BOB }, [ME, BOB]), null);
});

test("contactNameFor is a plain lookup and needs a real mxid", () => {
  assert.equal(contactNameFor({ [BOB]: "Денчик" }, BOB), "Денчик");
  assert.equal(contactNameFor({ [BOB]: "Денчик" }, CAROL), null);
  assert.equal(contactNameFor({ [BOB]: "  " }, BOB), null);
  assert.equal(contactNameFor({ [BOB]: "Денчик" }, null), null);
  assert.equal(contactNameFor(null, BOB), null);
});

// ------------------------------------------------------------------- writing

test("(в) reset drops the key and leaves no empty value", () => {
  const stored = { [BOB]: "Денчик", [CAROL]: "Мама" };
  assert.deepEqual(parseContactNames(withContactName(stored, BOB, "")), { [CAROL]: "Мама" });
  assert.deepEqual(parseContactNames(withContactName({ [BOB]: "Денчик" }, BOB, "")), {},
    "removing the last name must leave {}, not {\"@id\": \"\"}");
  for (const empty of ["", "   ", null, undefined]) {
    assert.deepEqual(withContactName({ [BOB]: "Денчик" }, BOB, empty), {});
  }
});

test("withContactName sets, trims and never mutates its input", () => {
  const before = { [BOB]: "one" };
  const next = withContactName(before, CAROL, "  два  ");
  assert.deepEqual(next, { [BOB]: "one", [CAROL]: "два" });
  assert.deepEqual(before, { [BOB]: "one" });
  assert.deepEqual(withContactName(undefined, BOB, "Денчик"), { [BOB]: "Денчик" });
});

test("withContactName replaces an existing name, and only that contact", () => {
  assert.deepEqual(withContactName({ [BOB]: "one", [CAROL]: "two" }, BOB, "Денчик"),
    { [BOB]: "Денчик", [CAROL]: "two" });
});

test("(г) a junk payload cannot corrupt the stored map on write", () => {
  // What a write sends is parse(withContactName(...)): junk keys and blank
  // values must not survive the round trip.
  const junk = { [BOB]: "", "not an mxid": "X", "@nocolon": "Y", [CAROL]: " Ok " };
  const written = parseContactNames(withContactName(junk, ME, " Себя "));
  assert.deepEqual(written, { [CAROL]: "Ok", [ME]: "Себя" });
});

// ------------------------------------------------------------------ SDK hook

test("installNameHook: a DM takes the contact's name for an opaque v12 id", () => {
  class FakeRoom {
    constructor(roomId) { this.roomId = roomId; }
    calculateRoomName(userId, ignoreRoomNameEvent) {
      return "stock:" + this.roomId + (ignoreRoomNameEvent ? ":default" : "");
    }
  }
  const names = { [BOB]: "Денчик" };
  const direct = { [V12]: BOB, "!group:example.org": CAROL };
  const resolve = (room) => contactNameForRoom(names, room.roomId, ME, direct,
    room.roomId === V12 ? [ME, BOB] : [ME, BOB, CAROL]);
  assert.equal(installNameHook(FakeRoom.prototype, resolve), true);

  const dm = new FakeRoom(V12);
  const group = new FakeRoom("!group:example.org");
  assert.equal(dm.calculateRoomName(ME), "Денчик");
  assert.equal(dm.calculateRoomName(ME, true), "stock:" + V12 + ":default",
    "getDefaultRoomName() must stay stock");
  assert.equal(group.calculateRoomName(ME), "stock:!group:example.org",
    "a group keeps its own name even when the map knows its members");
});

test("installNameHook resolves per room, not per hook instance", () => {
  class Room {
    constructor(roomId) { this.roomId = roomId; }
    calculateRoomName() { return "stock:" + this.roomId; }
  }
  let seen = [];
  const resolve = (room) => { seen.push(room.roomId); return null; };
  installNameHook(Room.prototype, resolve);
  new Room(V11).calculateRoomName(ME);
  new Room(V12).calculateRoomName(ME);
  assert.deepEqual(seen, [V11, V12]);
});

test("installNameHook is idempotent and refuses a proto without the method", () => {
  let calls = 0;
  class Room { calculateRoomName() { calls++; return "stock"; } }
  const resolve = () => "name";
  assert.equal(installNameHook(Room.prototype, resolve), true);
  assert.equal(installNameHook(Room.prototype, resolve), true);
  const room = new Room();
  assert.equal(room.calculateRoomName(ME), "name");
  assert.equal(calls, 0, "a personal name never reaches the original");
  assert.equal(room.calculateRoomName(ME, true), "stock");
  assert.equal(calls, 1, "the original must be wrapped exactly once");
  assert.equal(installNameHook({}, resolve), false);
  assert.equal(installNameHook(null, resolve), false);
});

// ---------------------------------------------------------------- UI contract
// Source-level pins for the two UI changes the user asked for (2026-11-10):
// the name dialog carries no example placeholder, and the header pencil is
// anchored to the name row instead of being appended under the name.
const source = require("node:fs").readFileSync(nodePath.resolve(process.argv[2]), "utf8");

test("the personal-name dialog has no placeholder text", () => {
  assert.equal(/placeholder/i.test(source), false,
    "no placeholder string and no input.placeholder assignment may stay");
});

test("the header pencil is anchored to the name row", () => {
  assert.match(source, /mx_RoomHeader_heading/, "the flex row that renders the name is the anchor");
  assert.match(source, /function insertAfterName/);
  assert.doesNotMatch(source, /info\.appendChild\(button\)/, "the old under-the-name append is gone");
});

test("(д) nothing in the overlay writes room state", () => {
  // The whole point: the name lives in this account's account data and the
  // other side never learns it. Guard the code, not the comment above it.
  const code = source.slice(source.indexOf("(function (root)"));
  for (const forbidden of ["sendStateEvent", "setRoomName", "m.room.name", "m.room.member",
    "setRoomTopic", "sendEvent"]) {
    assert.equal(code.includes(forbidden), false, `the overlay must not use ${forbidden}`);
  }
  assert.match(code, /setAccountData/);
});

test("the old room-keyed contract is mentioned only to say it is gone", () => {
  // The header comment names cc.plotina.room_aliases once, to state that the
  // old room model is neither read nor migrated. Anywhere else -- and in the
  // code at all -- the string must be absent (the card's grep check).
  const code = source.slice(source.indexOf("(function (root)"));
  assert.equal(code.includes("room_aliases"), false, "no code may touch the old key");
  const mentions = source.split("room_aliases").length - 1;
  assert.ok(mentions <= 1, `at most the one comment line, found ${mentions}`);
});

console.log(`ALL OK (${passed} tests)`);
