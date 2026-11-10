/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Unit tests for the personal-name overlay in Cinny (cc.plotina.room_aliases).

Run through scripts/test-dm-aliases.sh, which exports the pinned tag, applies
cinny/patches/ to it, bundles the modules the patch adds with the esbuild that
ships in Cinny's node_modules and hands node --test their paths:

  PLOTINA_ALIASES_CORE  src/plotina/roomAliases.ts        (pure storage rules)
  PLOTINA_ALIASES_GLUE  src/app/state/plotinaAliases.ts   (matrix + react glue)
  PLOTINA_ALIASES_SDK   matrix-js-sdk/lib/index.js        (the real SDK)

Three layers, because they fail differently:

  * the core module is pure -- parse/set/reset/junk, no client involved;
  * the glue is installed on a fake MatrixClient that models the SDK rule that
    matters here: Room.calculateRoomName() asks
    client.roomNameGenerator(roomId, state) first and falls back to the stock
    name on null, and account data is not room state, so only an explicit
    Room.recalculate() repaints the list. The fake fails loudly if anything
    writes room state;
  * the same glue is installed on a real MatrixClient from the pinned
    matrix-js-sdk with real Room objects, which pins the upstream contract: if
    a future tag stops consulting roomNameGenerator or drops
    Room.recalculate()/Room.name, the build of this patch fails here first.
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

/* ------------------------------------------------------------ storage rules */

test('the alias map is read from account data content', () => {
  const aliases = core.parseAliases({
    '!dm:test': 'Денчик',
    '!opaque': 'Мама', // room version 12: no ":" in the id, must still work
  });
  assert.deepEqual(aliases, { '!dm:test': 'Денчик', '!opaque': 'Мама' });
  assert.equal(core.aliasFor(aliases, '!dm:test'), 'Денчик');
  assert.equal(core.aliasFor(aliases, '!opaque'), 'Мама');
  assert.equal(core.aliasFor(aliases, '!other:test'), undefined);
});

test('an empty value means reset and leaves no key behind', () => {
  const set = core.aliasesWith({ '!dm:test': 'Денчик', '!x:test': 'X' }, '!dm:test', 'Денчик 2');
  assert.deepEqual(set, { '!dm:test': 'Денчик 2', '!x:test': 'X' });

  const reset = core.aliasesWith(set, '!dm:test', '   ');
  assert.deepEqual(reset, { '!x:test': 'X' });
  assert.equal(Object.prototype.hasOwnProperty.call(reset, '!dm:test'), false);

  // Resetting the last alias stores {}, never an empty string.
  assert.deepEqual(core.aliasesWith(reset, '!x:test', ''), {});
});

test('setting does not mutate the previous map and trims the name', () => {
  const before = { '!dm:test': 'Денчик' };
  const after = core.aliasesWith(before, '!b:test', '  Борис  ');
  assert.deepEqual(before, { '!dm:test': 'Денчик' });
  assert.equal(after['!b:test'], 'Борис');
});

test('junk account data reads as "no aliases" instead of throwing', () => {
  for (const raw of [null, undefined, '', 'not an object', 42, [], [1, 2], true]) {
    assert.deepEqual(core.parseAliases(raw), {}, `raw=${JSON.stringify(raw)}`);
  }

  // Half-broken content: the valid entry survives, the rest is dropped.
  assert.deepEqual(
    core.parseAliases({ '!dm:test': 'Денчик', '!a:test': '', '!b:test': null, '!c:test': 7 }),
    { '!dm:test': 'Денчик' }
  );

  // Entries that parse but carry no usable value never resolve.
  assert.equal(core.aliasFor({ '!dm:test': '  ' }, '!dm:test'), undefined);
});

test('the personal name only wins for a direct chat', () => {
  assert.equal(core.resolveRoomName('Даниил', 'Денчик', true), 'Денчик');
  assert.equal(core.resolveRoomName('Команда', 'Денчик', false), 'Команда');
  assert.equal(core.resolveRoomName('Даниил', undefined, true), 'Даниил');
  assert.equal(core.resolveRoomName(undefined, undefined, true), '');
  assert.equal(core.hasAliases({}), false);
  assert.equal(core.hasAliases({ '!dm:test': 'Денчик' }), true);
});

/* --------------------------------------------------- SDK display point glue */

const ACCOUNT_DATA_EVENT = 'accountData'; // ClientEvent.AccountData
const ROOM_NAME_EVENT = 'Room.name'; // RoomEvent.Name
const CLIENT_ROOM_EVENT = sdk.ClientEvent.Room; // 'Room'
const CLIENT_SYNC_EVENT = sdk.ClientEvent.Sync; // 'sync'

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
  constructor(client, roomId, { name, members = 2, space = false }) {
    this.client = client;
    this.roomId = roomId;
    this.baseName = name;
    this.name = name;
    this.members = members;
    this.space = space;
    this.nameEvents = 0;
  }

  isSpaceRoom() {
    return this.space;
  }

  getJoinedMemberCount() {
    return this.members;
  }

  getMember() {
    return undefined;
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

const fakeWithDirect = ({ direct = ['!dm:test'] } = {}) => {
  const mx = new FakeClient('@me:test');
  mx.data.set('m.direct', new FakeEvent('m.direct', { '@me:test': direct }));
  mx.rooms.push(
    new FakeRoom(mx, '!dm:test', { name: 'Даниил', members: 2 }),
    new FakeRoom(mx, '!grp:test', { name: 'Команда', members: 3 }),
    new FakeRoom(mx, '!pair:test', { name: 'Сосед', members: 2 }),
    new FakeRoom(mx, '!space:test', { name: 'Спейс', members: 2, space: true })
  );
  return mx;
};

test('the generator answers for a direct chat and defers otherwise', () => {
  const mx = fakeWithDirect();
  glue.installPlotinaRoomNames(mx);

  // Nothing stored yet: the SDK keeps its own name everywhere.
  for (const room of mx.rooms) assert.equal(glue.plotinaRoomName(mx, room), room.baseName);

  mx.data.set(
    'cc.plotina.room_aliases',
    new FakeEvent('cc.plotina.room_aliases', {
      '!dm:test': 'Денчик',
      '!grp:test': 'Моя группа',
      '!pair:test': 'Сосед по койке',
      '!space:test': 'Мой спейс',
    })
  );
  glue.recalculatePlotinaRoomNames(mx);

  assert.equal(mx.getRoom('!dm:test').name, 'Денчик', 'm.direct room takes the alias');
  assert.equal(mx.getRoom('!grp:test').name, 'Команда', 'a group room is never masked');
  assert.equal(mx.getRoom('!pair:test').name, 'Сосед по койке', 'two-member room is a DM');
  assert.equal(mx.getRoom('!space:test').name, 'Спейс', 'a space is not a DM');
});

test('a write repaints the list without a reload, and reset restores the name', async () => {
  const mx = fakeWithDirect();
  glue.installPlotinaRoomNames(mx);

  const dm = mx.getRoom('!dm:test');
  const group = mx.getRoom('!grp:test');

  await glue.setPlotinaAlias(mx, '!dm:test', '  Денчик  ');

  // No recalculate() call from the test: the account data listener did it.
  assert.equal(dm.name, 'Денчик');
  assert.equal(dm.nameEvents, 1, 'Room.recalculate() emitted Room.name once');
  assert.equal(mx.getAccountData('cc.plotina.room_aliases').getContent()['!dm:test'], 'Денчик');

  // A stale alias for a group room must not leak into its name.
  await glue.setPlotinaAlias(mx, '!grp:test', 'Моя группа');
  assert.equal(group.name, 'Команда');

  // Reset: the key is gone, the base name is back.
  await glue.setPlotinaAlias(mx, '!dm:test', '');
  assert.equal(dm.name, 'Даниил');
  assert.deepEqual(mx.getAccountData('cc.plotina.room_aliases').getContent(), {
    '!grp:test': 'Моя группа',
  });
  assert.equal(mx.stateWrites, 0, 'room state was never written');
  // m.direct is untouched by the feature.
  assert.deepEqual(mx.getAccountData('m.direct').getContent(), { '@me:test': ['!dm:test'] });
});

test('broken account data leaves the client working as before', async () => {
  const mx = fakeWithDirect();
  glue.installPlotinaRoomNames(mx);

  for (const junk of ['not an object', [], 42, null, { '!dm:test': { nested: true } }]) {
    mx.data.set(
      'cc.plotina.room_aliases',
      new FakeEvent('cc.plotina.room_aliases', junk)
    );
    assert.doesNotThrow(() => glue.recalculatePlotinaRoomNames(mx));
    assert.equal(mx.getRoom('!dm:test').name, 'Даниил');
  }

  // A write on top of junk still produces a clean map.
  await glue.setPlotinaAlias(mx, '!dm:test', 'Денчик');
  assert.deepEqual(mx.getAccountData('cc.plotina.room_aliases').getContent(), {
    '!dm:test': 'Денчик',
  });
  assert.equal(mx.getRoom('!dm:test').name, 'Денчик');
});

test('installing twice does not stack generators', () => {
  const mx = fakeWithDirect();
  glue.installPlotinaRoomNames(mx);
  const first = mx.roomNameGenerator;
  glue.installPlotinaRoomNames(mx);
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
 * after a client restart (patch 0012, cold start).
 */
test('cold start: a room named before it is in the client is fixed when it arrives', () => {
  const mx = new FakeClient('@me:test');
  mx.data.set('m.direct', new FakeEvent('m.direct', { '@me:test': ['!dm:cold'] }));
  glue.installPlotinaRoomNames(mx);

  // 1. The alias arrives with the global account data of the first sync, while
  //    the client still has no rooms: the listener has nothing to repaint.
  const aliases = new FakeEvent('cc.plotina.room_aliases', { '!dm:cold': 'Денчик' });
  mx.data.set('cc.plotina.room_aliases', aliases);
  mx.emit(ACCOUNT_DATA_EVENT, aliases);
  assert.equal(mx.rooms.length, 0);

  // 2. The room is created and named before it is stored: stock name.
  const dm = new FakeRoom(mx, '!dm:cold', { name: 'Даниил', members: 2 });
  dm.recalculate();
  assert.equal(dm.name, 'Даниил', 'generator cannot resolve a room that is not in the client yet');

  // 3. ClientEvent.Room, not an opened room and not a new message, is what
  //    puts the personal name into the list.
  mx.rooms.push(dm);
  mx.emit(CLIENT_ROOM_EVENT, dm);
  assert.equal(dm.name, 'Денчик');
  assert.equal(dm.nameEvents, 1, 'Room.name was emitted once, so the chat list repaints');
});

test('the first sync recomputes the names of rooms that were already there', () => {
  // A room restored from the local store may have been named before its alias
  // was known (the name was set on another device). Its account data event is
  // long gone by then; the sync state is the only signal that the sync is in.
  const mx = fakeWithDirect();
  glue.installPlotinaRoomNames(mx);
  const dm = mx.getRoom('!dm:test');
  assert.equal(dm.name, 'Даниил');

  mx.data.set(
    'cc.plotina.room_aliases',
    new FakeEvent('cc.plotina.room_aliases', { '!dm:test': 'Денчик' })
  );
  const aliases = mx.getAccountData('cc.plotina.room_aliases');

  // No account data event on this path: only the completed first sync.
  mx.emit(CLIENT_SYNC_EVENT, 'SYNCING');
  assert.equal(dm.name, 'Даниил', 'a running sync does not recompute on every response');

  mx.emit(CLIENT_SYNC_EVENT, 'PREPARED');
  assert.equal(dm.name, 'Денчик');
  // The room keeps the personal name for the rest of the session.
  mx.emit(ACCOUNT_DATA_EVENT, aliases);
  assert.equal(dm.name, 'Денчик');
  assert.equal(mx.stateWrites, 0, 'room state was never written');
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
    userId: '@me:test',
    deviceId: 'TEST',
  });
  putAccountData(mx, 'm.direct', { '@danya:test': ['!dm'] });
  return mx;
};

test('a real Room comes out of calculateRoomName with the personal name', () => {
  const mx = realClient();
  // "!dm" has no server part, like the opaque "!<base64url>" of room version
  // 12: no id shape is consulted anywhere, only the room's own data.
  putAccountData(mx, 'cc.plotina.room_aliases', { '!dm': 'Денчик', '!grp': 'Моя группа' });

  const dm = new sdk.Room('!dm', mx, '@me:test');
  const group = new sdk.Room('!grp', mx, '@me:test');
  mx.store.storeRoom(dm);
  mx.store.storeRoom(group);

  // The stock names, with no generator installed: both rooms are empty shells
  // here, which is enough -- what is asserted is that the generator is asked.
  const stockDm = dm.calculateRoomName('@me:test');
  const stockGroup = group.calculateRoomName('@me:test');

  glue.installPlotinaRoomNames(mx);

  assert.equal(dm.calculateRoomName('@me:test'), 'Денчик');
  assert.equal(group.calculateRoomName('@me:test'), stockGroup, 'group keeps the SDK name');
  assert.notEqual(stockDm, 'Денчик');
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
  putAccountData(mx, 'cc.plotina.room_aliases', { '!dm': 'Денчик' });

  const dm = new sdk.Room('!dm', mx, '@me:test');
  mx.store.storeRoom(dm);
  glue.installPlotinaRoomNames(mx);
  dm.recalculate();
  assert.equal(dm.name, 'Денчик');

  let emitted = 0;
  dm.on(sdk.RoomEvent.Name, () => {
    emitted += 1;
  });

  // Rename: one Room.name for the list to repaint, no reload.
  putAccountData(mx, 'cc.plotina.room_aliases', { '!dm': 'Денчик 2' });
  dm.recalculate();
  assert.equal(dm.name, 'Денчик 2');
  assert.equal(emitted, 1);

  // The path a rename takes when it comes from another device: /sync stores
  // the account data and emits ClientEvent.AccountData. Nothing in the test
  // recalculates by hand.
  putAccountData(mx, 'cc.plotina.room_aliases', { '!dm': 'Денчик 3' });
  mx.emit(sdk.ClientEvent.AccountData, mx.getAccountData('cc.plotina.room_aliases'));
  assert.equal(dm.name, 'Денчик 3');

  // Reset follows the same path back to the stock name.
  putAccountData(mx, 'cc.plotina.room_aliases', {});
  mx.emit(sdk.ClientEvent.AccountData, mx.getAccountData('cc.plotina.room_aliases'));
  assert.notEqual(dm.name, 'Денчик 3');
});

test('a real client fixes the cold-start name on Room and on the first sync', () => {
  const mx = realClient();
  putAccountData(mx, 'cc.plotina.room_aliases', { '!dm': 'Денчик' });
  glue.installPlotinaRoomNames(mx);

  // SDK order for a brand-new room: recalculate() first, storeRoom() after.
  const dm = new sdk.Room('!dm', mx, '@me:test');
  // What the SDK computes while the room is not yet in the client -- the name
  // it would keep for the whole session before this fix.
  const stock = dm.calculateRoomName('@me:test');
  dm.recalculate();
  assert.equal(dm.name, stock, 'the generator had no room to check yet');

  mx.store.storeRoom(dm);
  mx.emit(sdk.ClientEvent.Room, dm);
  assert.equal(dm.name, 'Денчик', 'ClientEvent.Room is enough -- no room open, no message');

  // The first sync recomputes everything again, which is also the path that
  // brings a reset made on another device without a reload.
  putAccountData(mx, 'cc.plotina.room_aliases', {});
  mx.emit(sdk.ClientEvent.Sync, sdk.SyncState.Prepared, sdk.SyncState.Syncing);
  assert.equal(dm.name, stock, 'PREPARED puts the stock name back after a reset');
});