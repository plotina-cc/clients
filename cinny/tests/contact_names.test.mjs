/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Unit tests for the personal-contact-name overlay in Cinny
(cc.plotina.contact_names).

Run through scripts/test-dm-aliases.sh, which exports the pinned tag, applies
cinny/patches/ to it, bundles the modules the patch adds with the esbuild that
ships in Cinny's node_modules and hands node --test their paths:

  PLOTINA_ALIASES_CORE  src/plotina/contactNames.ts            (pure rules)
  PLOTINA_ALIASES_GLUE  src/app/state/plotinaContactNames.ts   (matrix + react)
  PLOTINA_ALIASES_SDK   matrix-js-sdk/lib/index.js             (the real SDK)

Three layers, because they fail differently:

  * the core module is pure -- parse/set/reset/junk and the contact addressing,
    no client involved;
  * the glue is installed on a fake MatrixClient that models the SDK rule that
    matters here: Room.calculateRoomName() asks client.roomNameGenerator(roomId,
    state) first and falls back to the stock name on null, and account data is
    not room state, so only an explicit Room.recalculate() repaints the list.
    The fake fails loudly if anything writes room state;
  * the same glue is installed on a real MatrixClient from the pinned
    matrix-js-sdk with real Room objects, which pins the upstream contract: if
    a future tag stops consulting roomNameGenerator or drops
    Room.recalculate()/Room.name, the build of this patch fails here first.

The behaviour the card asks for, and where it is pinned here:
  (а) one person in two DMs -> one name, in both          "two chats, one name"
  (б) a contact name never reaches a group               "never masks a group"
  (в) a reset drops the key                              "an empty value means reset"
  (г) junk in account data does not break rendering      "junk account data"
  (д) m.room.name is never written                       stateWrites / HTTP PUTs
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

const ME = '@me:test';
const BOB = '@bob:test';
const CAROL = '@carol:test';

/* ------------------------------------------------------------ storage rules */

test('the name map is read from account data content', () => {
  const names = core.parseContactNames({ [BOB]: 'Денчик', [CAROL]: ' Мама ' });
  assert.deepEqual(names, { [BOB]: 'Денчик', [CAROL]: 'Мама' });
  assert.equal(core.contactNameFor(names, BOB), 'Денчик');
  assert.equal(core.contactNameFor(names, '@nobody:test'), undefined);
  assert.equal(core.contactNameFor(names, undefined), undefined);
});

test('keys that are not mxids are dropped, so the stored map is the shown map', () => {
  assert.deepEqual(
    core.parseContactNames({
      [BOB]: 'Денчик',
      '@nocolon': 'X',
      '@:server': 'X',
      '@user:': 'X',
      'plain': 'X',
      '!dm:test': 'X', // the old room-keyed shape: read as junk, never as a name
      '': 'X',
    }),
    { [BOB]: 'Денчик' }
  );
});

test('an empty value means reset and leaves no key behind', () => {
  const set = core.contactNamesWith({ [BOB]: 'Денчик', [CAROL]: 'Мама' }, BOB, 'Денчик 2');
  assert.deepEqual(set, { [BOB]: 'Денчик 2', [CAROL]: 'Мама' });

  const reset = core.contactNamesWith(set, BOB, '   ');
  assert.deepEqual(reset, { [CAROL]: 'Мама' });
  assert.equal(Object.prototype.hasOwnProperty.call(reset, BOB), false);

  // Resetting the last name stores {}, never an empty string.
  assert.deepEqual(core.contactNamesWith(reset, CAROL, ''), {});
  assert.deepEqual(core.contactNamesWith({ [BOB]: 'x' }, BOB, null), {});
});

test('setting does not mutate the previous map and trims the name', () => {
  const before = { [BOB]: 'Денчик' };
  const after = core.contactNamesWith(before, CAROL, '  Борис  ');
  assert.deepEqual(before, { [BOB]: 'Денчик' });
  assert.equal(after[CAROL], 'Борис');
});

test('junk account data reads as "no names" instead of throwing', () => {
  for (const raw of [null, undefined, '', 'not an object', 42, [], [1, 2], true]) {
    assert.deepEqual(core.parseContactNames(raw), {}, `raw=${JSON.stringify(raw)}`);
  }
  // Half-broken content: the valid entry survives, the rest is dropped.
  assert.deepEqual(
    core.parseContactNames({ [BOB]: 'Денчик', [CAROL]: '', '@x:test': null, '@y:test': 7 }),
    { [BOB]: 'Денчик' }
  );
  assert.equal(core.contactNameFor({ [BOB]: '  ' }, BOB), undefined);
});

/* ------------------------------------------------------ contact addressing */

test('(а) two chats with the same person carry one name', () => {
  const first = '!first:test';
  const second = '!opaqueV12RoomIdWithoutColon';
  const direct = core.directPartners({ [BOB]: [first, second] });
  const names = { [BOB]: 'Денчик' };

  assert.equal(core.contactNameForRoom(names, first, ME, direct, [ME, BOB]), 'Денчик');
  assert.equal(
    core.contactNameForRoom(names, second, ME, direct, [ME, BOB]),
    'Денчик',
    'the name is bound to the contact, not to the room'
  );
});

test('(б) a contact name never masks a group', () => {
  const group = '!group:test';
  const names = { [BOB]: 'Денчик', [CAROL]: 'Мама' };
  assert.equal(core.contactNameForRoom(names, group, ME, {}, [ME, BOB, CAROL]), undefined);
  // Not even when a stale m.direct entry points at a three-member room.
  assert.equal(
    core.contactNameForRoom(names, group, ME, { [group]: BOB }, [ME, BOB, CAROL]),
    undefined
  );
});

test('m.direct names the partner; the room id shape is never consulted', () => {
  // Opaque v12 ids have no ":" at all -- the production case.
  assert.equal(core.dmPartnerId('!opaque', ME, { '!opaque': BOB }, undefined), BOB);
  assert.equal(core.dmPartnerId('!dm:test', ME, {}, [ME, BOB]), BOB);
  assert.equal(core.dmPartnerId('!dm:test', ME, {}, [BOB, ME]), BOB);
  assert.equal(core.dmPartnerId('!dm:test', ME, { '!dm:test': ME }, [ME]), undefined, 'never myself');
  assert.equal(core.dmPartnerId('!dm:test', ME, {}, [ME]), undefined);
  assert.equal(core.dmPartnerId('!dm:test', ME, {}, undefined), undefined);
});

test('a room that only has a name from the old event resolves to nothing', () => {
  // cc.plotina.room_aliases keyed by room id would have said "Денчик" here.
  const roomId = '!dm:test';
  const legacyShape = { [roomId]: 'Денчик' };
  const parsed = core.parseContactNames(legacyShape);
  assert.deepEqual(parsed, {}, 'a room-id key is not an mxid and must be ignored');
  assert.equal(core.contactNameForRoom(parsed, roomId, ME, { [roomId]: BOB }, [ME, BOB]), undefined);
});

/* --------------------------------------------------- SDK display point glue */

const ACCOUNT_DATA_EVENT = 'accountData'; // ClientEvent.AccountData
const ROOM_NAME_EVENT = 'Room.name'; // RoomEvent.Name
const CLIENT_ROOM_EVENT = sdk.ClientEvent.Room; // 'Room'
const CLIENT_SYNC_EVENT = sdk.ClientEvent.Sync; // 'sync'
const CONTACT_NAMES_TYPE = 'cc.plotina.contact_names';

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

class FakeRoom {
  constructor(client, roomId, { name, members = [], space = false, inviter } = {}) {
    this.client = client;
    this.roomId = roomId;
    this.baseName = name;
    this.name = name;
    this.members = members;
    this.space = space;
    this.inviter = inviter;
    this.nameEvents = 0;
  }

  isSpaceRoom() {
    return this.space;
  }

  getJoinedMemberCount() {
    return this.members.length;
  }

  getJoinedMembers() {
    return this.members.map((userId) => ({ userId }));
  }

  getMember(userId) {
    if (userId !== this.client.userId) return undefined;
    return {
      events: { member: new FakeEvent('m.room.member', this.inviter ? { is_direct: true } : {}) },
    };
  }

  getDMInviter() {
    return this.inviter;
  }

  recalculate() {
    // The SDK contract: the generator answers first, null means stock name.
    const answer = this.client.roomNameGenerator
      ? this.client.roomNameGenerator(this.roomId, { type: 2, name: this.baseName })
      : null;
    const next = answer === null || answer === undefined ? this.baseName : answer;
    if (next !== this.name) {
      this.name = next;
      this.nameEvents += 1;
      this.client.emit(ROOM_NAME_EVENT, this);
    }
    return this.name;
  }
}

class FakeClient {
  constructor(userId) {
    this.userId = userId;
    this.data = new Map();
    this.rooms = [];
    this.handlers = new Map();
    this.stateWrites = 0;
  }

  getUserId() {
    return this.userId;
  }

  getSafeUserId() {
    return this.userId;
  }

  getAccountData(type) {
    return this.data.get(type);
  }

  async setAccountData(type, content) {
    this.data.set(type, new FakeEvent(type, JSON.parse(JSON.stringify(content))));
    this.emit(ACCOUNT_DATA_EVENT, this.data.get(type));
  }

  // Writing room state is exactly what this feature must never do.
  sendStateEvent() {
    this.stateWrites += 1;
    throw new Error('m.room.name must not be written for a personal name');
  }

  getRoom(roomId) {
    return this.rooms.find((room) => room.roomId === roomId) ?? null;
  }

  getRooms() {
    return this.rooms;
  }

  on(event, handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  removeListener(event, handler) {
    const list = this.handlers.get(event) ?? [];
    this.handlers.set(
      event,
      list.filter((item) => item !== handler)
    );
    return this;
  }

  emit(event, payload) {
    (this.handlers.get(event) ?? []).forEach((handler) => handler(payload));
  }
}

/**
 * Two DMs with the same person, one group, one space. `!dmTwo` has an opaque
 * id with no ":" -- the room version 12 shape production DMs use.
 */
const fakeWithContacts = () => {
  const mx = new FakeClient(ME);
  mx.data.set('m.direct', new FakeEvent('m.direct', { [BOB]: ['!dm:test', '!dmTwo'], [CAROL]: ['!dmC:test'] }));
  mx.rooms.push(
    new FakeRoom(mx, '!dm:test', { name: 'Даниил', members: [ME, BOB] }),
    new FakeRoom(mx, '!dmTwo', { name: 'Даниил', members: [ME, BOB] }),
    new FakeRoom(mx, '!dmC:test', { name: 'Каролина', members: [ME, CAROL] }),
    new FakeRoom(mx, '!grp:test', { name: 'Команда', members: [ME, BOB, CAROL] }),
    new FakeRoom(mx, '!space:test', { name: 'Спейс', members: [ME, BOB], space: true })
  );
  return mx;
};

test('the generator answers for a DM and defers for everything else', () => {
  const mx = fakeWithContacts();
  glue.installPlotinaContactNames(mx);

  // Nothing stored yet: the SDK keeps its own name everywhere.
  for (const room of mx.rooms) assert.equal(glue.plotinaRoomName(mx, room), room.baseName);

  mx.data.set(
    CONTACT_NAMES_TYPE,
    new FakeEvent(CONTACT_NAMES_TYPE, { [BOB]: 'Денчик', [CAROL]: 'Мама' })
  );
  glue.recalculatePlotinaRoomNames(mx);

  assert.equal(mx.getRoom('!dm:test').name, 'Денчик', 'a DM takes the contact name');
  assert.equal(mx.getRoom('!dmTwo').name, 'Денчик', '(а) the second DM with him follows');
  assert.equal(mx.getRoom('!dmC:test').name, 'Мама', 'each contact has their own name');
  assert.equal(mx.getRoom('!grp:test').name, 'Команда', '(б) a group room is never masked');
  assert.equal(mx.getRoom('!space:test').name, 'Спейс', 'a space is not a contact');
});

test('(а) naming a person in one chat renames them in the other, without a reload', async () => {
  const mx = fakeWithContacts();
  glue.installPlotinaContactNames(mx);

  const first = mx.getRoom('!dm:test');
  const second = mx.getRoom('!dmTwo');

  await glue.setPlotinaContactName(mx, first, '  Денчик  ');

  // No recalculate() call from the test: the account data listener did it.
  assert.equal(first.name, 'Денчик');
  assert.equal(second.name, 'Денчик', 'the other chat with the same person repainted too');
  assert.equal(first.nameEvents, 1, 'Room.recalculate() emitted Room.name once');
  assert.deepEqual(mx.getAccountData(CONTACT_NAMES_TYPE).getContent(), { [BOB]: 'Денчик' });
});

test('(в) a reset drops the key and restores every chat with that person', async () => {
  const mx = fakeWithContacts();
  glue.installPlotinaContactNames(mx);

  await glue.setPlotinaContactName(mx, mx.getRoom('!dm:test'), 'Денчик');
  await glue.setPlotinaContactName(mx, mx.getRoom('!dmC:test'), 'Мама');
  await glue.setPlotinaContactName(mx, mx.getRoom('!dm:test'), '');

  assert.deepEqual(mx.getAccountData(CONTACT_NAMES_TYPE).getContent(), { [CAROL]: 'Мама' });
  assert.equal(mx.getRoom('!dm:test').name, 'Даниил');
  assert.equal(mx.getRoom('!dmTwo').name, 'Даниил', 'the sibling chat lost the name too');
  assert.equal(mx.getRoom('!dmC:test').name, 'Мама', 'the other contact is untouched');
  assert.equal(mx.stateWrites, 0, '(д) room state was never written');
  // m.direct is untouched by the feature.
  assert.deepEqual(mx.getAccountData('m.direct').getContent(), {
    [BOB]: ['!dm:test', '!dmTwo'],
    [CAROL]: ['!dmC:test'],
  });
});

test('(б) writing a name for a group room writes nothing at all', async () => {
  const mx = fakeWithContacts();
  glue.installPlotinaContactNames(mx);

  await glue.setPlotinaContactName(mx, mx.getRoom('!grp:test'), 'Моя группа');
  await glue.setPlotinaContactName(mx, mx.getRoom('!space:test'), 'Мой спейс');

  assert.equal(mx.getAccountData(CONTACT_NAMES_TYPE), undefined, 'no key was created');
  assert.equal(mx.getRoom('!grp:test').name, 'Команда');
  assert.equal(mx.getRoom('!space:test').name, 'Спейс');
  assert.equal(mx.stateWrites, 0);
});

test('(г) broken account data leaves the client working as before', async () => {
  const mx = fakeWithContacts();
  glue.installPlotinaContactNames(mx);

  for (const junk of ['not an object', [], 42, null, { [BOB]: { nested: true } }, { '!dm:test': 'X' }]) {
    mx.data.set(CONTACT_NAMES_TYPE, new FakeEvent(CONTACT_NAMES_TYPE, junk));
    assert.doesNotThrow(() => glue.recalculatePlotinaRoomNames(mx));
    assert.equal(mx.getRoom('!dm:test').name, 'Даниил', `junk=${JSON.stringify(junk)}`);
  }

  // A write on top of junk still produces a clean map under the contact's mxid.
  await glue.setPlotinaContactName(mx, mx.getRoom('!dm:test'), 'Денчик');
  assert.deepEqual(mx.getAccountData(CONTACT_NAMES_TYPE).getContent(), { [BOB]: 'Денчик' });
  assert.equal(mx.getRoom('!dm:test').name, 'Денчик');
});

test('a pending direct invite resolves to the inviter', async () => {
  const mx = new FakeClient(ME);
  mx.data.set('m.direct', new FakeEvent('m.direct', {}));
  const invite = new FakeRoom(mx, '!invite:test', {
    name: 'Bob',
    members: [],
    inviter: BOB,
  });
  mx.rooms.push(invite);
  glue.installPlotinaContactNames(mx);

  await glue.setPlotinaContactName(mx, invite, 'Денчик');
  assert.deepEqual(mx.getAccountData(CONTACT_NAMES_TYPE).getContent(), { [BOB]: 'Денчик' });
  assert.equal(invite.name, 'Денчик');
});

test('installing twice does not stack generators', () => {
  const mx = fakeWithContacts();
  glue.installPlotinaContactNames(mx);
  const first = mx.roomNameGenerator;
  glue.installPlotinaContactNames(mx);
  assert.equal(mx.roomNameGenerator, first);
});

/**
 * The order matrix-js-sdk uses on the first /sync (sync.js): global account
 * data is applied and emitted BEFORE the room sections, and every brand-new
 * room is recalculated BEFORE storeRoom() and ClientEvent.Room. So the
 * generator is asked about a room the client cannot see yet, and the name the
 * room is born with is the member-list one. Nothing recomputes it afterwards --
 * account data is not room state -- and the chat list keeps showing that name
 * until the room is opened or an event arrives in it. QA found exactly that
 * after a client restart (cold start).
 */
test('cold start: a room named before it is in the client is fixed when it arrives', () => {
  const mx = new FakeClient(ME);
  mx.data.set('m.direct', new FakeEvent('m.direct', { [BOB]: ['!dm:cold'] }));
  glue.installPlotinaContactNames(mx);

  // 1. The name arrives with the global account data of the first sync, while
  //    the client still has no rooms: the listener has nothing to repaint.
  const names = new FakeEvent(CONTACT_NAMES_TYPE, { [BOB]: 'Денчик' });
  mx.data.set(CONTACT_NAMES_TYPE, names);
  mx.emit(ACCOUNT_DATA_EVENT, names);
  assert.equal(mx.rooms.length, 0);

  // 2. The room is created and named before it is stored: stock name.
  const dm = new FakeRoom(mx, '!dm:cold', { name: 'Даниил', members: [ME, BOB] });
  dm.recalculate();
  assert.equal(dm.name, 'Даниил', 'the generator cannot resolve a room that is not in the client yet');

  // 3. ClientEvent.Room, not an opened room and not a new message, is what
  //    puts the personal name into the list.
  mx.rooms.push(dm);
  mx.emit(CLIENT_ROOM_EVENT, dm);
  assert.equal(dm.name, 'Денчик');
  assert.equal(dm.nameEvents, 1, 'Room.name was emitted once, so the chat list repaints');
});

test('the first sync recomputes the names of rooms that were already there', () => {
  // A room restored from the local store may have been named before its
  // contact's name was known (set on another device). Its account data event
  // is long gone by then; the sync state is the only signal that sync is in.
  const mx = fakeWithContacts();
  glue.installPlotinaContactNames(mx);
  const dm = mx.getRoom('!dm:test');
  assert.equal(dm.name, 'Даниил');

  mx.data.set(CONTACT_NAMES_TYPE, new FakeEvent(CONTACT_NAMES_TYPE, { [BOB]: 'Денчик' }));
  const names = mx.getAccountData(CONTACT_NAMES_TYPE);

  // No account data event on this path: only the completed first sync.
  mx.emit(CLIENT_SYNC_EVENT, 'SYNCING');
  assert.equal(dm.name, 'Даниил', 'a running sync does not recompute on every response');

  mx.emit(CLIENT_SYNC_EVENT, 'PREPARED');
  assert.equal(dm.name, 'Денчик');
  // The room keeps the personal name for the rest of the session.
  mx.emit(ACCOUNT_DATA_EVENT, names);
  assert.equal(dm.name, 'Денчик');
  assert.equal(mx.stateWrites, 0, '(д) room state was never written');
});

test('an m.direct change repaints without touching the name map', () => {
  const mx = fakeWithContacts();
  glue.installPlotinaContactNames(mx);
  mx.data.set(CONTACT_NAMES_TYPE, new FakeEvent(CONTACT_NAMES_TYPE, { [BOB]: 'Денчик' }));
  glue.recalculatePlotinaRoomNames(mx);

  const loose = mx.getRoom('!grp:test');
  assert.equal(loose.name, 'Команда', 'a group with two other people is not a contact');

  // The same room, now listed in m.direct against Bob -- and with Bob as the
  // only other member, as a real DM would have.
  const room = new FakeRoom(mx, '!late:test', { name: 'Даниил', members: [ME, BOB] });
  mx.rooms.push(room);
  mx.data.set('m.direct', new FakeEvent('m.direct', { [BOB]: ['!late:test'] }));
  mx.emit(ACCOUNT_DATA_EVENT, mx.getAccountData('m.direct'));
  assert.equal(room.name, 'Денчик', 'm.direct is part of the answer and repaints on its own');
});

/* ------------------------------------------------------ against the real SDK */

// MemoryStore keeps account data in this map; Cinny's own developer-tools page
// reads it the same way. Using the real store means the glue's
// mx.getAccountData() path is the one the app uses.
const putAccountData = (mx, type, content) => {
  mx.store.accountData.set(type, new sdk.MatrixEvent({ type, content }));
};

const realClient = () => {
  const mx = sdk.createClient({
    baseUrl: 'http://localhost:1',
    userId: ME,
    deviceId: 'TEST',
  });
  putAccountData(mx, 'm.direct', { [BOB]: ['!dm'] });
  return mx;
};

test('a real Room comes out of calculateRoomName with the contact name', () => {
  const mx = realClient();
  // "!dm" has no server part, like the opaque "!<base64url>" of room version
  // 12: no id shape is consulted anywhere, only the room's own data.
  putAccountData(mx, CONTACT_NAMES_TYPE, { [BOB]: 'Денчик' });

  const dm = new sdk.Room('!dm', mx, ME);
  const group = new sdk.Room('!grp', mx, ME);
  mx.store.storeRoom(dm);
  mx.store.storeRoom(group);

  // The membership the generator resolves the partner from. !dm is in m.direct
  // against BOB, so the two-member rule is not even needed here.
  dm.currentState.setStateEvents([
    new sdk.MatrixEvent({
      type: 'm.room.member',
      state_key: ME,
      sender: ME,
      content: { membership: 'join', displayname: 'Me' },
    }),
    new sdk.MatrixEvent({
      type: 'm.room.member',
      state_key: BOB,
      sender: BOB,
      content: { membership: 'join', displayname: 'Bob' },
    }),
  ]);

  const stockGroup = group.calculateRoomName(ME);

  glue.installPlotinaContactNames(mx);

  assert.equal(dm.calculateRoomName(ME), 'Денчик');
  assert.equal(group.calculateRoomName(ME), stockGroup, 'a room outside m.direct keeps the SDK name');
  // calculateRoomName() returns a value; it does not assign Room.name (the
  // constructor left it as the room id), which is why recalculate() below is
  // what makes the app see the change.
  assert.equal(dm.name, '!dm');

  dm.recalculate();
  assert.equal(dm.name, 'Денчик');
  // Room search matches on normalizedName, which the SDK recomputes from the
  // name in recalculate(); it maps Cyrillic to lookalike glyphs ("Денчик" ->
  // "дeʜчᴎĸ"), so this compares shape, not letters.
  assert.notEqual(dm.normalizedName, '!dm');
  assert.equal(dm.normalizedName.length, 'Денчик'.length);
});

test('a real Room repaints on recalculate() and on the account data event', () => {
  const mx = realClient();
  putAccountData(mx, CONTACT_NAMES_TYPE, { [BOB]: 'Денчик' });

  const dm = new sdk.Room('!dm', mx, ME);
  mx.store.storeRoom(dm);
  glue.installPlotinaContactNames(mx);
  dm.recalculate();
  assert.equal(dm.name, 'Денчик');

  let emitted = 0;
  dm.on(sdk.RoomEvent.Name, () => {
    emitted += 1;
  });

  // Rename: one Room.name for the list to repaint, no reload.
  putAccountData(mx, CONTACT_NAMES_TYPE, { [BOB]: 'Денчик 2' });
  dm.recalculate();
  assert.equal(dm.name, 'Денчик 2');
  assert.equal(emitted, 1);

  // The path a rename takes when it comes from another device: /sync stores
  // the account data and emits ClientEvent.AccountData. Nothing in the test
  // recalculates by hand.
  putAccountData(mx, CONTACT_NAMES_TYPE, { [BOB]: 'Денчик 3' });
  mx.emit(sdk.ClientEvent.AccountData, mx.getAccountData(CONTACT_NAMES_TYPE));
  assert.equal(dm.name, 'Денчик 3');

  // Reset follows the same path back to the stock name.
  putAccountData(mx, CONTACT_NAMES_TYPE, {});
  mx.emit(sdk.ClientEvent.AccountData, mx.getAccountData(CONTACT_NAMES_TYPE));
  assert.notEqual(dm.name, 'Денчик 3');
});

test('a real client fixes the cold-start name on Room and on the first sync', () => {
  const mx = realClient();
  putAccountData(mx, CONTACT_NAMES_TYPE, { [BOB]: 'Денчик' });
  glue.installPlotinaContactNames(mx);

  // SDK order for a brand-new room: recalculate() first, storeRoom() after.
  const dm = new sdk.Room('!dm', mx, ME);
  // What the SDK computes while the room is not yet in the client -- the name
  // it would keep for the whole session before this fix.
  const stock = dm.calculateRoomName(ME);
  dm.recalculate();
  assert.equal(dm.name, stock, 'the generator had no room to check yet');

  mx.store.storeRoom(dm);
  mx.emit(sdk.ClientEvent.Room, dm);
  assert.equal(dm.name, 'Денчик', 'ClientEvent.Room is enough -- no room open, no message');

  // The first sync recomputes everything again, which is also the path that
  // brings a reset made on another device without a reload.
  putAccountData(mx, CONTACT_NAMES_TYPE, {});
  mx.emit(sdk.ClientEvent.Sync, sdk.SyncState.Prepared, sdk.SyncState.Syncing);
  assert.equal(dm.name, stock, 'PREPARED puts the stock name back after a reset');
});
