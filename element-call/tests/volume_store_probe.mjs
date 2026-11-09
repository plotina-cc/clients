#!/usr/bin/env node
/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Exercises the store that patches/0004-plotina-persistent-volume.patch adds
 * under plain node: no node_modules, no browser, no homeserver.
 *
 * tests/test_volume_persistence.py copies this file next to the module the
 * patch adds and runs it, so what is tested here is the code that actually
 * ships rather than a copy of it. That works because the store has no runtime
 * imports at all — it reaches the Matrix client and localStorage through the
 * options it is given.
 *
 * Prints one `PASS <name>` or `FAIL <name>: <reason>` line per case and exits
 * non-zero if any of them failed.
 */

import assert from "node:assert/strict";

import {
  ACCOUNT_DATA_TYPE,
  LOCAL_STORAGE_KEY,
  MAX_ENTRIES,
  PersistentVolumeStore,
  WRITE_DEBOUNCE_MS,
  applyPersistedVolume,
  mergeVolumeMaps,
  parseStoredVolumes,
  screenShareVolumeKey,
} from "./PersistentVolume.ts";

const ALICE = "@alice:example.org";
const BOB = "@bob:example.org";

/** Stands in for localStorage. */
class MemoryStorage {
  constructor(initial = {}) {
    this.data = { ...initial };
    this.writes = 0;
  }

  getItem(key) {
    return Object.hasOwn(this.data, key) ? this.data[key] : null;
  }

  setItem(key, value) {
    this.writes++;
    this.data[key] = value;
  }
}

/** Stands in for the slice of MatrixClient the store touches. */
function fakeClient({
  content,
  user = "@me:example.org",
  rejectWrites = false,
  server = null,
} = {}) {
  const listeners = new Set();
  const writes = [];
  const client = {
    getUserId: () => user,
    getAccountData: (type) => {
      const value = typeof content === "function" ? content() : content;
      return type === ACCOUNT_DATA_TYPE && value !== undefined
        ? { getContent: () => value }
        : undefined;
    },
    setAccountData: (type, body) => {
      if (rejectWrites) return Promise.reject(new Error("M_LIMIT_EXCEEDED"));
      writes.push([type, body]);
      if (server) server.content = body;
      return Promise.resolve({});
    },
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
  };
  return {
    client,
    writes,
    emit: (body) => {
      for (const listener of listeners) {
        listener({ getType: () => ACCOUNT_DATA_TYPE, getContent: () => body });
      }
    },
  };
}

function makeStore({ storage, client = null, debounceMs = 0 } = {}) {
  let clock = 1000;
  return new PersistentVolumeStore({
    storage,
    client,
    debounceMs,
    now: () => clock++,
  });
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the shape of what is stored -------------------------------------------

test("an unadjusted participant has no saved volume", () => {
  const store = makeStore({ storage: new MemoryStorage(), client: fakeClient().client });
  assert.equal(store.get(ALICE), null);
});

test("a saved volume survives a restart", () => {
  const storage = new MemoryStorage();
  const client = fakeClient();
  makeStore({ storage, client: client.client }).set(ALICE, 0.7);
  // A restart is a fresh store reading the same cache.
  assert.deepEqual(
    makeStore({ storage, client: client.client }).get(ALICE),
    { volume: 0.7, muted: false },
  );
});

test("muting keeps the level to unmute to", () => {
  const storage = new MemoryStorage();
  const client = fakeClient();
  const store = makeStore({ storage, client: client.client });
  store.set(ALICE, 0.7);
  store.set(ALICE, 0, true);
  assert.deepEqual(store.get(ALICE), { volume: 0.7, muted: true });
  assert.deepEqual(
    makeStore({ storage, client: client.client }).get(ALICE),
    { volume: 0.7, muted: true },
  );
});

test("volumes outside 0..1 are clamped", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  store.set(ALICE, 4);
  assert.equal(store.get(ALICE).volume, 1);
  store.set(BOB, -2);
  assert.deepEqual(store.get(BOB), { volume: 1, muted: true });
});

test("junk volumes are rejected", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  for (const junk of [Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, {}, []]) {
    store.set(ALICE, junk);
    assert.equal(store.get(ALICE), null, `accepted ${JSON.stringify(junk)}`);
  }
});

test("keys that are not Matrix user ids are not stored", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  for (const key of ["alice", "@alice", "", "alice@example.org", "@a:b:c"]) {
    store.set(key, 0.5);
    assert.equal(store.get(key), null, `accepted ${JSON.stringify(key)}`);
  }
});

test("the screen share key is the mxid plus the source", () => {
  assert.equal(screenShareVolumeKey(ALICE), `${ALICE}#screenshare`);
});

test("a participant's mic and screen share are remembered separately", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  store.set(ALICE, 0.4);
  store.set(screenShareVolumeKey(ALICE), 0.9);
  assert.equal(store.get(ALICE).volume, 0.4);
  assert.equal(store.get(screenShareVolumeKey(ALICE)).volume, 0.9);
});

// --- two devices ------------------------------------------------------------

test("a newer value from another device wins", () => {
  const merged = mergeVolumeMaps(
    { [ALICE]: { volume: 0.5, muted: false, ts: 100 } },
    { [ALICE]: { volume: 0.8, muted: true, ts: 200 } },
  );
  assert.deepEqual(merged[ALICE], { volume: 0.8, muted: true, ts: 200 });
});

test("an older value from another device does not overwrite", () => {
  const merged = mergeVolumeMaps(
    { [ALICE]: { volume: 0.5, muted: false, ts: 200 } },
    { [ALICE]: { volume: 0.8, muted: true, ts: 100 } },
  );
  assert.deepEqual(merged[ALICE], { volume: 0.5, muted: false, ts: 200 });
});

test("keys only one device knows about are merged in, not dropped", () => {
  const merged = mergeVolumeMaps(
    { [ALICE]: { volume: 0.5, muted: false, ts: 100 } },
    { [BOB]: { volume: 0.2, muted: false, ts: 50 } },
  );
  assert.deepEqual(Object.keys(merged).sort(), [ALICE, BOB].sort());
});

test("the other device's value reaches a running call", () => {
  const device = fakeClient({
    content: { [ALICE]: { volume: 0.3, muted: false, ts: 10 } },
  });
  const store = makeStore({ storage: new MemoryStorage(), client: device.client });
  let notified = 0;
  store.onChange(ALICE, () => {
    notified++;
  });
  assert.equal(store.get(ALICE).volume, 0.3);
  device.emit({ [ALICE]: { volume: 0.25, muted: true, ts: 20 } });
  assert.equal(notified, 1);
  assert.deepEqual(store.get(ALICE), { volume: 0.25, muted: true });
});

test("switching accounts drops the previous account's volumes", () => {
  // The store finds the client on window, so a switch of account is a switch
  // of window.matrixclient — which is what a logout and login looks like.
  globalThis.window = { addEventListener: () => {} };
  try {
    const storage = new MemoryStorage();
    const store = new PersistentVolumeStore({ storage, debounceMs: 0 });
    globalThis.window.matrixclient = fakeClient({
      user: "@first:example.org",
    }).client;
    store.set(ALICE, 0.2);
    store.set(BOB, 0.6);
    assert.equal(store.get(BOB).volume, 0.6);

    globalThis.window.matrixclient = fakeClient({
      user: "@second:example.org",
      content: { [ALICE]: { volume: 0.9, muted: false, ts: 5 } },
    }).client;
    // The new account's own copy wins, and the old account's entries are gone
    // from the store and from the cache the next start would read.
    assert.deepEqual(store.get(ALICE), { volume: 0.9, muted: false });
    assert.equal(store.get(BOB), null);
    const cached = JSON.parse(storage.getItem(LOCAL_STORAGE_KEY));
    assert.equal(cached[BOB], undefined);
  } finally {
    delete globalThis.window;
  }
});

// --- limits and damaged data ------------------------------------------------

test("what one device saves is there on the other device's next start", async () => {
  // The homeserver copy, shared by the two devices below.
  const server = { content: undefined };
  const laptop = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient({ server }).client,
    debounceMs: 20,
  });
  laptop.set(ALICE, 0.35);
  await sleep(60);

  const phone = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient({ content: () => server.content }).client,
  });
  assert.deepEqual(phone.get(ALICE), { volume: 0.35, muted: false });
});

test(`at most ${MAX_ENTRIES} entries are kept, oldest evicted`, async () => {
  const client = fakeClient();
  const store = makeStore({ storage: new MemoryStorage(), client: client.client });
  for (let i = 0; i < MAX_ENTRIES + 100; i++) {
    store.set(`@user${i}:example.org`, 0.5);
  }
  await store.flush();
  assert.equal(client.writes.length, 1);
  const written = client.writes[0][1];
  assert.equal(Object.keys(written).length, MAX_ENTRIES);
  assert.equal(written["@user99:example.org"], undefined);
  assert.notEqual(written[`@user${MAX_ENTRIES + 99}:example.org`], undefined);
});

test("corrupt cached JSON is a cold start, not a crash", () => {
  const storage = new MemoryStorage({ [LOCAL_STORAGE_KEY]: "{not json" });
  const store = makeStore({ storage, client: fakeClient().client });
  assert.equal(store.get(ALICE), null);
  store.set(ALICE, 0.5);
  assert.equal(store.get(ALICE).volume, 0.5);
  assert.equal(parseStoredVolumes("[]").constructor, Object);
});

test("junk in account data is ignored and the good entries survive", () => {
  const device = fakeClient({
    content: {
      "not-an-mxid": { volume: 0.5, muted: false, ts: 1 },
      [BOB]: { volume: "loud", muted: false, ts: 2 },
      [ALICE]: { volume: 0.6, muted: false, ts: 3 },
    },
  });
  const store = makeStore({ storage: new MemoryStorage(), client: device.client });
  assert.deepEqual(store.get(ALICE), { volume: 0.6, muted: false });
  assert.equal(store.get(BOB), null);
  // A whole event that is not even a map must not throw either.
  for (const junk of ["nonsense", 42, [], null]) {
    device.emit(junk);
  }
  assert.deepEqual(store.get(ALICE), { volume: 0.6, muted: false });
});

// --- the two layers ---------------------------------------------------------

test("the cache works when the server has no account data", () => {
  const storage = new MemoryStorage();
  const client = fakeClient();
  makeStore({ storage, client: client.client }).set(ALICE, 0.6);
  const restarted = makeStore({ storage, client: fakeClient().client });
  assert.equal(restarted.get(ALICE).volume, 0.6);
});

test("a failed account data write does not lose the cached value", async () => {
  const storage = new MemoryStorage();
  const store = makeStore({
    storage,
    client: fakeClient({ rejectWrites: true }).client,
  });
  store.set(ALICE, 0.6);
  await store.flush();
  assert.equal(store.get(ALICE).volume, 0.6);
  assert.equal(
    makeStore({ storage, client: fakeClient().client }).get(ALICE).volume,
    0.6,
  );
});

test("account data is written once the slider settles", async () => {
  const client = fakeClient();
  const store = makeStore({
    storage: new MemoryStorage(),
    client: client.client,
    debounceMs: 20,
  });
  store.set(ALICE, 0.6);
  store.set(ALICE, 0.7);
  store.set(ALICE, 0.8);
  assert.equal(client.writes.length, 0);
  await sleep(60);
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0][0], ACCOUNT_DATA_TYPE);
  assert.equal(client.writes[0][1][ALICE].volume, 0.8);
  assert.equal(typeof client.writes[0][1][ALICE].ts, "number");
});

test(`the debounce is ${WRITE_DEBOUNCE_MS} ms`, () => {
  assert.equal(WRITE_DEBOUNCE_MS, 500);
});

test("an unchanged value is not written again", async () => {
  const client = fakeClient();
  const store = makeStore({
    storage: new MemoryStorage(),
    client: client.client,
    debounceMs: 20,
  });
  store.set(ALICE, 0.5);
  await sleep(60);
  store.set(ALICE, 0.5);
  await sleep(60);
  assert.equal(client.writes.length, 1);
});

test("without an account nothing is remembered", () => {
  const storage = new MemoryStorage({
    [LOCAL_STORAGE_KEY]: JSON.stringify({
      [ALICE]: { volume: 0.4, muted: false, ts: 1 },
    }),
  });
  const store = new PersistentVolumeStore({ storage, client: null });
  assert.equal(store.get(ALICE), null);
  store.set(ALICE, 0.2);
  assert.equal(storage.writes, 0);
});

// --- what the ViewModels use ------------------------------------------------

function fakeControls() {
  const calls = [];
  let volume = 1;
  return {
    calls,
    controls: {
      adjustPlaybackVolume: (value) => {
        volume = value;
        calls.push(`adjust:${value}`);
      },
      commitPlaybackVolume: () => calls.push(`commit`),
      togglePlaybackMuted: () => {
        volume = volume === 0 ? 1 : 0;
        calls.push(`toggle:${volume}`);
      },
    },
  };
}

test("a restored volume is applied the way a user would set it", () => {
  const store = makeStore({
    storage: new MemoryStorage({
      [LOCAL_STORAGE_KEY]: JSON.stringify({
        [ALICE]: { volume: 0.7, muted: true, ts: 1 },
      }),
    }),
    client: fakeClient().client,
  });
  const { calls, controls } = fakeControls();
  applyPersistedVolume(ALICE, controls, store);
  assert.deepEqual(calls, ["adjust:0.7", "commit", "toggle:0"]);
});

test("nothing is applied when the participant was never adjusted", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  const { calls, controls } = fakeControls();
  applyPersistedVolume(ALICE, controls, store);
  assert.deepEqual(calls, []);
});

// --- runner -----------------------------------------------------------------

let failures = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
console.log(`SUMMARY pass=${cases.length - failures} fail=${failures}`);
process.exit(failures === 0 ? 0 : 1);