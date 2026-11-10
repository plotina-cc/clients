// Node tests for plotina-dm-aliases.js — run with:
//   node element-web/tests/dm_aliases.test.js element-web/plotina-dm-aliases.js
// (branding_test.py wires this into element-web/tests/run.sh's unittest suite)
//
// Covered here: the pure map handling, the room-id contract for both id
// shapes (v<=11 "!localpart:server" and the v12 opaque "!<base64url>"), the
// DM-only rule and the Room.name hook with a fake prototype. The browser and
// the real SDK are covered by spike-dm-aliases/proof.mjs (run against a real
// v12 Synapse in FIX-dm-aliases-v12.md).
"use strict";

const assert = require("node:assert/strict");
const nodePath = require("node:path");
const {
  ACCOUNT_DATA_TYPE,
  DIRECT_EVENT_TYPE,
  isRoomId,
  parseAliases,
  withAlias,
  aliasFor,
  aliasRejection,
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

test("account data type is the documented one", () => {
  assert.equal(ACCOUNT_DATA_TYPE, "cc.plotina.room_aliases");
});

test("m.direct is the DM account data type", () => {
  assert.equal(DIRECT_EVENT_TYPE, "m.direct");
});

test("accepts room ids of both shapes (v12 opaque has no colon)", () => {
  assert.equal(isRoomId(V11), true);
  assert.equal(isRoomId(V12), true);
  assert.equal(isRoomId("!abc"), true);
});

test("rejects things that are not room ids", () => {
  for (const bad of ["", "!", "plain", "@user:example.org", "#alias:example.org",
    "!has space", "!a/b", "!trailing ", 42, null, undefined, {}]) {
    assert.equal(isRoomId(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("reads a room_id -> label map", () => {
  const content = { "!abc:example.org": "Денчик", "!def:example.org": "Мама" };
  assert.deepEqual(parseAliases(content), content);
});

test("keeps a v12 opaque room id (DEFECT-1 regression)", () => {
  const content = { [V12]: "Денчик" };
  assert.deepEqual(parseAliases(content), content);
  assert.equal(aliasFor(parseAliases(content), V12, true), "Денчик");
});

test("trims labels and drops empty or non-string values", () => {
  const out = parseAliases({
    "!abc:example.org": "  Денчик  ",
    "!empty:example.org": "   ",
    "!num:example.org": 42,
    "!null:example.org": null,
    "!obj:example.org": { name: "x" },
  });
  assert.deepEqual(out, { "!abc:example.org": "Денчик" });
});

test("ignores keys that are not room ids", () => {
  const out = parseAliases({
    "!abc:example.org": "Денчик",
    [V12]: "Денчик v12",
    "@user:example.org": "not a room",
    "": "empty key",
    "plain": "nope",
  });
  assert.deepEqual(out, { "!abc:example.org": "Денчик", [V12]: "Денчик v12" });
});

test("tolerates null, undefined and non-object content", () => {
  for (const bad of [null, undefined, "", "text", 7, []]) {
    assert.deepEqual(parseAliases(bad), {});
  }
});

test("aliasFor answers only for direct rooms", () => {
  const map = { [V12]: "Денчик", "!group:example.org": "Группа" };
  assert.equal(aliasFor(map, V12, true), "Денчик");
  assert.equal(aliasFor(map, V12, false), null, "a group room must keep its own name");
  assert.equal(aliasFor(map, "!other", true), null);
  assert.equal(aliasFor({ [V12]: "  " }, V12, true), null);
  assert.equal(aliasFor(null, V12, true), null);
});

test("aliasRejection: v12 DM is allowed", () => {
  assert.equal(aliasRejection(V12, "Денчик", { known: true, direct: true }), null);
  assert.equal(aliasRejection(V11, "Денчик", { known: true, direct: true }), null);
});

test("aliasRejection: a group room cannot be renamed for one account", () => {
  assert.equal(aliasRejection(V12, "Денчик", { known: true, direct: false }), "not_direct");
  assert.equal(aliasRejection("!group:example.org", "x", { known: true, direct: false }),
    "not_direct");
});

test("aliasRejection: malformed ids are refused, clearing never is", () => {
  for (const bad of ["", "!", "@user:example.org", "plain", "!a b"]) {
    assert.equal(aliasRejection(bad, "x", { known: true, direct: true }),
      "invalid_room_id", `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(aliasRejection(V12, "x", { known: false, direct: false }), "unknown_room");
  assert.equal(aliasRejection(V12, "", { known: false, direct: false }), null,
    "a stale alias must always be removable");
  assert.equal(aliasRejection(V12, "   ", { known: true, direct: false }), null);
});

test("installNameHook: Room.name takes the alias for an opaque v12 id", () => {
  class FakeRoom {
    constructor(roomId) { this.roomId = roomId; }
    calculateRoomName(userId, ignoreRoomNameEvent) {
      return "stock:" + this.roomId + (ignoreRoomNameEvent ? ":default" : "");
    }
  }
  const resolve = (roomId) => (roomId === V12 ? "Денчик" : null);
  assert.equal(installNameHook(FakeRoom.prototype, resolve), true);
  const dm = new FakeRoom(V12);
  const group = new FakeRoom("!group:example.org");
  assert.equal(dm.calculateRoomName("@alice:localhost"), "Денчик");
  assert.equal(dm.calculateRoomName("@alice:localhost", true), "stock:" + V12 + ":default",
    "getDefaultRoomName() must stay stock");
  assert.equal(group.calculateRoomName("@alice:localhost"),
    "stock:!group:example.org", "a room without an alias keeps its own name");
});

test("installNameHook is idempotent and refuses a proto without the method", () => {
  let calls = 0;
  class Room { calculateRoomName() { calls++; return "stock"; } }
  const resolve = () => "alias";
  assert.equal(installNameHook(Room.prototype, resolve), true);
  assert.equal(installNameHook(Room.prototype, resolve), true);
  const room = new Room();
  assert.equal(room.calculateRoomName("@a:b"), "alias");
  assert.equal(calls, 0, "an alias answer never reaches the original");
  assert.equal(room.calculateRoomName("@a:b", true), "stock");
  assert.equal(calls, 1, "the original must be wrapped exactly once");
  assert.equal(installNameHook({}, resolve), false);
  assert.equal(installNameHook(null, resolve), false);
});

test("withAlias sets, trims and leaves the input map alone", () => {
  const before = { "!a:x": "one" };
  const next = withAlias(before, "!b:x", "  два  ");
  assert.deepEqual(next, { "!a:x": "one", "!b:x": "два" });
  assert.deepEqual(before, { "!a:x": "one" });
});

test("withAlias replaces an existing label", () => {
  assert.deepEqual(withAlias({ "!a:x": "one" }, "!a:x", "Денчик"),
    { "!a:x": "Денчик" });
});

test("withAlias removes on empty or blank, and never mutates", () => {
  const before = { "!a:x": "one", "!b:x": "two" };
  for (const empty of ["", "   ", null, undefined]) {
    assert.deepEqual(withAlias(before, "!a:x", empty), { "!b:x": "two" });
  }
  assert.deepEqual(before, { "!a:x": "one", "!b:x": "two" });
});

test("withAlias accepts a missing map", () => {
  assert.deepEqual(withAlias(undefined, "!a:x", "Денчик"), { "!a:x": "Денчик" });
});

test("reset writes {} with no empty values (FINDING-3 regression)", () => {
  const stored = { [V12]: "Денчик", [V11]: "Мама" };
  // The payload the overlay PUTs is exactly what these two helpers produce.
  assert.deepEqual(parseAliases(withAlias(stored, V12, "")), { [V11]: "Мама" });
  assert.deepEqual(parseAliases(withAlias({ [V12]: "Денчик" }, V12, "")), {},
    "removing the last alias must leave {}, not {\"!id\": \"\"}");
  for (const value of Object.values(parseAliases(withAlias(stored, V12, "")))) {
    assert.notEqual(value.trim(), "");
  }
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

console.log("ALL OK (" + passed + " tests)");