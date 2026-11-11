/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Unit tests for the second half of the contact-name model in Cinny: names of the
PEOPLE in a room, not just of a dialogue.

The card's rule is "one name per person": a contact named "Денчик" reads
"Денчик" in every direct chat with them AND in every group they share with this
account, in the message author line and in the member list. The name is keyed by
mxid, so a group cannot show a different name for the same person -- if it did,
the name would be a property of the room again.

Where the names come from, in this order (the owner's model, same as the Mobile
reference `User.displayName = resolveLocalName(id) ?? <member state name>`):
  1. cc.plotina.contact_names[mxid];
  2. the member's own displayname (m.room.member);
  3. nothing -- the caller falls back to the mxid localpart, as upstream does.

Surfaces pinned here:
  * getMemberDisplayName(room, userId) -- src/app/utils/room.ts -- the single
    point 32 of the 35 member-name reads in the client go through;
  * the member-list sort comparator -- src/app/hooks/useMemberSort.ts -- which
    read RoomMember.name directly (the A-Z order would disagree with the shown
    names);
  * the mention insertion path -- UserMentionAutocomplete -- which used
    roomMember.name for the pill text;
  * the repaint subscription an open room needs, because account data is not
    room state: without it the author names already on screen keep the old name
    until a reload.

Run through scripts/test-dm-aliases.sh, which exports the pinned tag, applies
cinny/patches/ to it and bundles the modules with the esbuild that ships in
Cinny's dependency tree.
*/
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const load = async (envName) => {
  const path = process.env[envName];
  assert.ok(path, `${envName} is not set -- run cinny/scripts/test-dm-aliases.sh`);
  return import(pathToFileURL(path).href);
};

const core = await load('PLOTINA_ALIASES_CORE');
const glue = await load('PLOTINA_ALIASES_GLUE');
const sdk = await load('PLOTINA_ALIASES_SDK');
// The display point and the sort comparator, bundled together with the pure
// member-name rules so the tests exercise the real modules the build compiles.
const roomModule = await load('PLOTINA_MEMBER_NAMES');

const { getMemberDisplayName } = roomModule;
const { MemberSort, memberNameCompare } = roomModule.sort;
const { personalNameForMember, memberOwnName, personalNameOf } = roomModule.memberNames;

const ME = '@me:test';
const BOB = '@bob:test';
const CAROL = '@carol:test';
const NAMES_TYPE = 'cc.plotina.contact_names';

/* --------------------------------------------------------------- fixtures */

class FakeEvent {
  constructor(type, content) {
    this.type = type;
    this.content = content;
  }

  getType() {
    return this.type;
  }

  getContent() {
    return this.content;
  }
}

/**
 * A client that stores account data the way the SDK does (event objects in a
 * map, emitted on ClientEvent.AccountData) and counts room-state writes, which
 * this feature must never do.
 */
class FakeClient {
  constructor(userId) {
    this.userId = userId;
    this.data = new Map();
    this.handlers = new Map();
    this.stateWrites = 0;
    this.rooms = [];
  }

  getRooms() {
    return this.rooms;
  }

  getRoom(roomId) {
    return this.rooms.find((room) => room.roomId === roomId);
  }


  getUserId() {
    return this.userId;
  }

  getAccountData(type) {
    return this.data.get(type);
  }

  async setAccountData(type, content) {
    this.data.set(type, new FakeEvent(type, JSON.parse(JSON.stringify(content))));
    this.emit('accountData', this.data.get(type));
    return {};
  }

  sendStateEvent() {
    this.stateWrites += 1;
    throw new Error('room state must not be written for a personal name');
  }

  on(event, handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  removeListener(event, handler) {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((item) => item !== handler)
    );
    return this;
  }

  emit(event, payload) {
    [...(this.handlers.get(event) ?? [])].forEach((handler) => handler(payload));
  }
}

/** A room with member displaynames, as m.room.member would have set them. */
const fakeRoom = (mx, { roomId = '!grp:test', members = {} } = {}) => ({
  roomId,
  client: mx,
  getMember: (userId) =>
    Object.prototype.hasOwnProperty.call(members, userId)
      ? { userId, rawDisplayName: members[userId] }
      : undefined,
  getJoinedMembers: () => Object.keys(members).map((userId) => ({ userId })),
});

const namedClient = (names) => {
  const mx = new FakeClient(ME);
  if (names) mx.data.set(NAMES_TYPE, new FakeEvent(NAMES_TYPE, names));
  return mx;
};

/* ----------------------------------------------------- priority of names */

test('(б) a group shows the contact name for the author and the member list', () => {
  const mx = namedClient({ [BOB]: 'Денчик', [CAROL]: 'Мама' });
  const room = fakeRoom(mx, {
    members: { [ME]: 'Я', [BOB]: 'Даниил', [CAROL]: 'Каролина' },
  });

  // The author line and every member tile read through this one function.
  assert.equal(getMemberDisplayName(room, BOB), 'Денчик');
  assert.equal(getMemberDisplayName(room, CAROL), 'Мама');
  // Someone this account never named keeps their own displayname.
  assert.equal(getMemberDisplayName(room, ME), 'Я');
});

test('(а) one person reads the same in a DM and in a group', () => {
  const mx = namedClient({ [BOB]: 'Денчик' });
  const group = fakeRoom(mx, { roomId: '!grp:test', members: { [ME]: 'Я', [BOB]: 'Даниил' } });
  const dm = fakeRoom(mx, { roomId: '!dm:test', members: { [ME]: 'Я', [BOB]: 'Даниил' } });

  assert.equal(getMemberDisplayName(dm, BOB), 'Денчик');
  assert.equal(
    getMemberDisplayName(group, BOB),
    getMemberDisplayName(dm, BOB),
    'the key is the mxid, so a group cannot disagree with the DM'
  );
});

test('without a personal name the member displayname comes first, then nothing', () => {
  const mx = namedClient(undefined);
  const room = fakeRoom(mx, { members: { [BOB]: 'Даниил', [CAROL]: CAROL } });

  assert.equal(personalNameOf(mx, BOB), undefined);
  assert.equal(personalNameForMember(room, BOB), undefined);
  // Upstream's own name, untouched.
  assert.equal(memberOwnName(room, BOB), 'Даниил');
  assert.equal(getMemberDisplayName(room, BOB), 'Даниил');
  // The SDK's "no name" marker (rawDisplayName == mxid) stays undefined, so the
  // caller keeps falling back to the localpart exactly as before.
  assert.equal(memberOwnName(room, CAROL), undefined);
  assert.equal(getMemberDisplayName(room, CAROL), undefined);
  // A member the room does not know is not invented.
  assert.equal(getMemberDisplayName(room, '@ghost:test'), undefined);
});

test('the personal name wins over the member displayname, and only for that person', () => {
  const mx = namedClient({ [BOB]: 'Денчик' });
  const room = fakeRoom(mx, { members: { [ME]: 'Я', [BOB]: 'Даниил', [CAROL]: 'Каролина' } });

  assert.equal(memberOwnName(room, BOB), 'Даниил', 'rawDisplayName is never rewritten');
  assert.equal(getMemberDisplayName(room, BOB), 'Денчик');
  assert.equal(getMemberDisplayName(room, CAROL), 'Каролина');
});

/* ------------------------------------------------------------------- junk */

test('(е) broken account data does not break the member name', () => {
  const room = (mx) => fakeRoom(mx, { members: { [ME]: 'Я', [BOB]: 'Даниил' } });

  for (const junk of [null, 'not an object', [], 42, { [BOB]: { nested: true } }, { '!grp:test': 1 }]) {
    const mx = new FakeClient(ME);
    mx.data.set(NAMES_TYPE, new FakeEvent(NAMES_TYPE, junk));
    const r = room(mx);
    assert.doesNotThrow(() => getMemberDisplayName(r, BOB), `junk=${JSON.stringify(junk)}`);
    assert.equal(getMemberDisplayName(r, BOB), 'Даниил', `junk=${JSON.stringify(junk)}`);
  }

  // A resolver that throws must leave upstream behaviour exactly as it was.
  const mx = new FakeClient(ME);
  mx.data.set(NAMES_TYPE, {
    getType: () => NAMES_TYPE,
    getContent: () => {
      throw new Error('boom');
    },
  });
  const r = room(mx);
  assert.doesNotThrow(() => getMemberDisplayName(r, BOB));
  assert.equal(getMemberDisplayName(r, BOB), 'Даниил');

  // A name stored under a key that is not an mxid is never shown to anyone.
  const bad = namedClient({ '!grp:test': 'Денчик', [BOB]: '  ' });
  assert.equal(getMemberDisplayName(room(bad), BOB), 'Даниил');
});

/* ------------------------------------------------- member list A-Z order */

test('the member list sorts by the name it shows', () => {
  const mx = namedClient({ [BOB]: 'Яков' });
  const room = fakeRoom(mx, { members: { [ME]: 'Я', [BOB]: 'Даниил', [CAROL]: 'Борис' } });
  const member = (userId) => ({ userId, name: room.getMember(userId).rawDisplayName });

  const byShownName = memberNameCompare(
    (m) => getMemberDisplayName(room, m.userId) ?? m.userId,
    1
  );
  const sorted = [member(BOB), member(CAROL), member(ME)].sort(byShownName);

  // "Борис" < "Я" (me) < "Яков" -- the personal name sorts where it is read,
  // not where the member state says it should ("Даниил" would be first).
  assert.deepEqual(
    sorted.map((m) => m.userId),
    [CAROL, ME, BOB]
  );
  // Upstream's own comparators are still there for callers that do not resolve.
  assert.equal(typeof MemberSort.Ascending, 'function');
  assert.equal(typeof MemberSort.NewestFirst, 'function');
});

/* --------------------------------------------------------- mention insert */

test('a mention inserted from the autocomplete carries the personal name', () => {
  const mx = namedClient({ [BOB]: 'Денчик' });
  const room = fakeRoom(mx, { members: { [ME]: 'Я', [BOB]: 'Даниил' } });

  // UserMentionAutocomplete inserts `getName(roomMember)`, never
  // roomMember.name -- otherwise the pill would say "Даниил" while the message
  // list says "Денчик" for the same person.
  const getName = (member) =>
    getMemberDisplayName(room, member.userId) ?? member.userId;
  assert.equal(getName({ userId: BOB, name: 'Даниил' }), 'Денчик');
});

/* --------------------------------------------------------- open room repaint */

test('an open room is told when the name map changes', () => {
  const mx = namedClient({ [BOB]: 'Денчик' });
  const seen = [];
  const unsubscribe = glue.subscribeContactNames(mx, () => seen.push('repaint'));

  // A rename from this device and from another one both arrive the same way.
  mx.emit('accountData', new FakeEvent(NAMES_TYPE, { [BOB]: 'Денчик 2' }));
  mx.emit('accountData', new FakeEvent(NAMES_TYPE, {}));
  // Everything else must not repaint the timeline on every sync response.
  mx.emit('accountData', new FakeEvent('m.direct', {}));
  mx.emit('accountData', new FakeEvent('im.vector.setting.breadcrumbs', {}));

  assert.equal(seen.length, 2);
  unsubscribe();
  mx.emit('accountData', new FakeEvent(NAMES_TYPE, { [BOB]: 'Денчик 3' }));
  assert.equal(seen.length, 2, 'the subscription stops when the room unmounts');
});

test('setting and resetting a name never writes room state', async () => {
  const mx = namedClient(undefined);
  mx.data.set('m.direct', new FakeEvent('m.direct', { [BOB]: ['!dm:test'] }));
  const room = fakeRoom(mx, { roomId: '!dm:test', members: { [ME]: 'Я', [BOB]: 'Даниил' } });
  room.roomId = '!dm:test';
  glue.installPlotinaContactNames(mx);

  await glue.setPlotinaContactName(mx, room, 'Денчик');
  assert.equal(getMemberDisplayName(room, BOB), 'Денчик');
  await glue.setPlotinaContactName(mx, room, '');
  assert.equal(getMemberDisplayName(room, BOB), 'Даниил', 'a reset restores the own name');
  assert.deepEqual(mx.getAccountData(NAMES_TYPE).getContent(), {}, 'the last reset leaves {}');
  assert.equal(mx.stateWrites, 0, 'm.room.name / m.room.member were never touched');
});

/* ------------------------------------------------------- against the real SDK */

/**
 * The display point relies on Room carrying its client (that is where the
 * account data lives) and on getMember().rawDisplayName. Both are upstream
 * facts, so they are pinned against the real SDK rather than the fake above: a
 * future tag that moves either one fails here instead of silently dropping the
 * personal name from groups.
 */
test('a real Room resolves the contact name in a group and in a DM', () => {
  const mx = sdk.createClient({ baseUrl: 'http://localhost:1', userId: ME, deviceId: 'TEST' });
  mx.store.accountData.set(NAMES_TYPE, new sdk.MatrixEvent({ type: NAMES_TYPE, content: { [BOB]: 'Денчик' } }));
  mx.store.accountData.set('m.direct', new sdk.MatrixEvent({ type: 'm.direct', content: { [BOB]: ['!dm'] } }));

  const withMembers = (roomId) => {
    const room = new sdk.Room(roomId, mx, ME);
    mx.store.storeRoom(room);
    room.currentState.setStateEvents([
      new sdk.MatrixEvent({
        type: 'm.room.member',
        state_key: ME,
        sender: ME,
        room_id: roomId,
        content: { membership: 'join', displayname: 'Я' },
      }),
      new sdk.MatrixEvent({
        type: 'm.room.member',
        state_key: BOB,
        sender: BOB,
        room_id: roomId,
        content: { membership: 'join', displayname: 'Даниил' },
      }),
      new sdk.MatrixEvent({
        type: 'm.room.member',
        state_key: CAROL,
        sender: CAROL,
        room_id: roomId,
        content: { membership: 'join', displayname: 'Каролина' },
      }),
    ]);
    return room;
  };

  const group = withMembers('!grp');
  const dm = withMembers('!dm');

  assert.equal(memberOwnName(group, BOB), 'Даниил', 'the real room reports the member state name');
  // "!"-ids of room version 12 have no ":": the rule must not depend on the id.
  assert.equal(getMemberDisplayName(group, BOB), 'Денчик', 'a real group takes the contact name');
  assert.equal(getMemberDisplayName(dm, BOB), 'Денчик', 'and so does the DM -- one name per person');
  assert.equal(getMemberDisplayName(group, CAROL), 'Каролина', 'the others keep their own name');
});

test('a real Room keeps the personal name when the map changes on another device', () => {
  const mx = sdk.createClient({ baseUrl: 'http://localhost:1', userId: ME, deviceId: 'TEST' });
  const room = new sdk.Room('!grp', mx, ME);
  mx.store.storeRoom(room);
  room.currentState.setStateEvents([
    new sdk.MatrixEvent({
      type: 'm.room.member',
      state_key: BOB,
      sender: BOB,
      room_id: '!grp',
      content: { membership: 'join', displayname: 'Даниил' },
    }),
  ]);
  assert.equal(getMemberDisplayName(room, BOB), 'Даниил');

  mx.store.accountData.set(NAMES_TYPE, new sdk.MatrixEvent({ type: NAMES_TYPE, content: { [BOB]: 'Денчик' } }));
  mx.emit(sdk.ClientEvent.AccountData, mx.getAccountData(NAMES_TYPE));
  assert.equal(getMemberDisplayName(room, BOB), 'Денчик');

  mx.store.accountData.set(NAMES_TYPE, new sdk.MatrixEvent({ type: NAMES_TYPE, content: {} }));
  mx.emit(sdk.ClientEvent.AccountData, mx.getAccountData(NAMES_TYPE));
  assert.equal(getMemberDisplayName(room, BOB), 'Даниил', 'a reset from another device is picked up');
});
