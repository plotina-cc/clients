#!/usr/bin/env node
/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Integration proof of the contact-name overlay against the REAL matrix-js-sdk
the Web client pins (44.0.0), not against the fakes the unit tests use.

Why this exists: the unit suite (element-web/tests/contact_names.test.js) proves
the overlay's own logic with hand-written member/room objects. This script
proves the assumptions that logic rests on, using the upstream classes:

  1. RoomMember.name / .rawDisplayName are plain own properties that
     setMembershipEvent() writes, so wrapping that prototype method and
     rewriting the two fields is enough — no upstream hook exists, none needed.
  2. Room.calculateRoomName() is the single place a room title is computed and
     an explicit m.room.name wins there, so returning null for a named room
     leaves the real title in place.
  3. Both installers are idempotent: the FIRST resolver wins, so it must read
     live state (the overlay's own engine.install passes closures over
     engine.names). This script keeps one live config for the same reason — a
     proof that re-installed a resolver per case would silently test nothing.

Neither substitutes for a browser run against a live homeserver (that is
spike-dm-aliases/proof-contact-names.mjs); this is the layer between the unit
tests and that end-to-end run.

Run (dependencies are NOT part of this repo):
    mkdir /tmp/realsdk && cd /tmp/realsdk && npm i matrix-js-sdk@44.0.0
    NODE_PATH=/tmp/realsdk/node_modules \
      node element-web/spike-dm-aliases/proof-real-sdk.mjs \
        element-web/plotina-dm-aliases.js
*/
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const overlayPath = path.resolve(process.argv[2] || "element-web/plotina-dm-aliases.js");
const overlay = require(overlayPath);

const { RoomMember } = require("matrix-js-sdk/lib/models/room-member");
const { Room } = require("matrix-js-sdk/lib/models/room");
const { MatrixEvent } = require("matrix-js-sdk/lib/models/event");
const sdkPkg = require("matrix-js-sdk/package.json");

const results = [];
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${check}: ${detail}`);
}

const ME = "@alice:example.org";
const BOB = "@bob:example.org";
const CAROL = "@carol:example.org";
const V12 = "!SXCZ-1RDqc_JxejRKA17NoOqnAUk2TuB9bBy9GMTIuo";
const NAMED = "!namedRoom:example.org";
const GROUP = "!x1bjMrsUU-PgPMGjzJh-f6IWkIdY-M6L7c7g4SI6Q2Q";

// The one live config the member hook reads — the shape engine.install uses (a
// closure over the name map), so a reset here is a mutation, not a re-install.
const live = {
  names: { [BOB]: "Денчик" },
  marker: null, // set to a string to prove the room-level resolve is consulted
  engine: null,
};

function memberEvent(userId, displayname, roomId, membership = "join") {
  return new MatrixEvent({
    type: "m.room.member",
    state_key: userId,
    sender: userId,
    room_id: roomId,
    event_id: "$" + Math.random().toString(36).slice(2),
    origin_server_ts: Date.now(),
    content: { membership, displayname },
  });
}

console.log(`-- matrix-js-sdk ${sdkPkg.version} (the Web pin)`);
record("real SDK major is the pinned one", sdkPkg.version.startsWith("44."), sdkPkg.version);

/* ------------------------------------------------------ RoomMember (author) */

record("installMemberHook wraps RoomMember.prototype.setMembershipEvent",
  overlay.installMemberHook(RoomMember.prototype,
    (member) => overlay.contactNameFor(live.names, member && member.userId)) === true, "true");
record("installing twice keeps the first resolver (idempotent)",
  overlay.installMemberHook(RoomMember.prototype, () => null) === true,
  "a second install must not replace the live resolver");

// A group room's members, driven by real membership events like a sync.
const bob = new RoomMember(GROUP, BOB);
const carol = new RoomMember(GROUP, CAROL);
const me = new RoomMember(GROUP, ME);
for (const [m, id, name] of [[bob, BOB, "Даниил"], [carol, CAROL, "Каролина"], [me, ME, "Алиса"]]) {
  m.setMembershipEvent(memberEvent(id, name, GROUP));
}

record("a real RoomMember in a group room carries the contact name in .name",
  bob.name === "Денчик", `name=${JSON.stringify(bob.name)}`);
record("...and in .rawDisplayName (the author line under a message)",
  bob.rawDisplayName === "Денчик", `rawDisplayName=${JSON.stringify(bob.rawDisplayName)}`);
record("another member of the same group keeps their own name",
  carol.name === "Каролина" && carol.rawDisplayName === "Каролина",
  `name=${JSON.stringify(carol.name)} raw=${JSON.stringify(carol.rawDisplayName)}`);
record("the signed-in user is never renamed",
  me.name === "Алиса", `name=${JSON.stringify(me.name)}`);

bob.setMembershipEvent(memberEvent(BOB, "Даниил", GROUP));
record("a second sync keeps the contact name", bob.name === "Денчик", `name=${JSON.stringify(bob.name)}`);

// Reset empties the map; the hook must give the person's CURRENT real name
// back, including a rename they made while the personal name was on.
const other = new RoomMember(GROUP, BOB);
other.setMembershipEvent(memberEvent(BOB, "Даниил", GROUP));
record("a fresh member under the hook takes the name", other.name === "Денчик", other.name);
delete live.names[BOB];
other.setMembershipEvent(memberEvent(BOB, "Даниил Петров", GROUP));
record("after reset a server-side rename shows through",
  other.name === "Даниил Петров", `name=${JSON.stringify(other.name)}`);

// Put the name back for the room-title half of the proof.
live.names[BOB] = "Денчик";

/* ------------------------------------------------------------- Room title */

// A real Room needs a client only for lazily-created members.
const clientStub = { getUserId: () => ME, getSafeUserId: () => ME, isGuest: () => false };
const dm = new Room(V12, clientStub, ME);
const group = new Room(GROUP, clientStub, ME);
const named = new Room(NAMED, clientStub, ME);
const dmMembers = [memberEvent(ME, "Алиса", V12), memberEvent(BOB, "Даниил", V12)];
const groupMembers = [
  memberEvent(ME, "Алиса", GROUP),
  memberEvent(BOB, "Даниил", GROUP),
  memberEvent(CAROL, "Каролина", GROUP),
];
dm.currentState.setStateEvents(dmMembers);
group.currentState.setStateEvents(groupMembers);
named.currentState.setStateEvents([memberEvent(ME, "Алиса", NAMED), memberEvent(BOB, "Даниил", NAMED)]);
named.currentState.setStateEvents([new MatrixEvent({
  type: "m.room.name", state_key: "", sender: ME, room_id: NAMED,
  event_id: "$name1", origin_server_ts: Date.now(), content: { name: "Наш проект" },
})]);

// The REAL engine over the REAL Room objects. clientStub answers getRoom() so
// partnerOf() can see the rooms; the DM is declared through m.direct, exactly
// as the client does.
const V11 = "!legacy:example.org";
const roomsById = { [V12]: dm, [GROUP]: group, [NAMED]: named };
const realClient = Object.assign({}, clientStub, {
  getRoom: (id) => roomsById[id] || null,
  getRooms: () => Object.values(roomsById),
  getAccountData: (type) => (type === "m.direct"
    ? { getType: () => type, getContent: () => ({ [BOB]: [V12, V11] }) }
    : undefined),
  on: () => {},
  setAccountData: () => Promise.resolve({}),
});
const engine = overlay.createEngine({ client: realClient });
engine.names = live.names; // share the live map the member hook reads
engine.direct = { [V12]: BOB, [V11]: BOB };
live.engine = engine;

// Stock baseline before any patch: what upstream computes on its own.
const stockGroupTitle = group.calculateRoomName(ME);
record("stock SDK: a group title comes from its members",
  typeof stockGroupTitle === "string" && stockGroupTitle.length > 0, JSON.stringify(stockGroupTitle));

record("installNameHook wraps Room.prototype.calculateRoomName",
  overlay.installNameHook(Room.prototype, (roomId) => {
    if (live.marker) return live.marker;
    // The production resolver, not a stand-in: engine.nameForRoom decides a
    // room title, including the "an explicit m.room.name wins" rule, against
    // the REAL Room objects below.
    return engine.nameForRoom(roomId);
  }) === true, "true");

dm.recalculate();
group.recalculate();
named.recalculate();

record("a DM title takes the contact name through real Room.recalculate()",
  dm.name === "Денчик", `Room.name=${JSON.stringify(dm.name)}`);
record("a group title is NOT taken over by the contact name",
  group.name === stockGroupTitle, `Room.name=${JSON.stringify(group.name)} stock=${JSON.stringify(stockGroupTitle)}`);
record("an explicit m.room.name beats the contact name in the room title",
  named.name === "Наш проект", `Room.name=${JSON.stringify(named.name)}`);

// getDefaultRoomName() asks with ignoreRoomNameEvent=true, so the room-level
// resolve must not be consulted at all. Assert with a marker the stock
// calculation can never produce: the person's own display name is "Денчик" by
// now (that is the feature), so only a foreign marker proves the hook stepped
// aside.
live.marker = "ROOM-LEVEL-RESOLVE-MARKER";
const dm2 = new Room(V12, clientStub, ME);
dm2.currentState.setStateEvents(dmMembers);
record("getDefaultRoomName() never sees the room-level resolve (ignoreRoomNameEvent=true)",
  dm2.getDefaultRoomName(ME) !== live.marker,
  `getDefaultRoomName=${JSON.stringify(dm2.getDefaultRoomName(ME))}`);
record("...while the same room's own title does take it",
  dm2.calculateRoomName(ME) === live.marker, JSON.stringify(dm2.calculateRoomName(ME)));
live.marker = null;

/* -------------------------------------------------------------- summary */

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `FAILED (${failed.length}/${results.length})` : `ALL OK (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
