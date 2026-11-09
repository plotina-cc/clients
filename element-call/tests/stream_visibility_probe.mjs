#!/usr/bin/env node
/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/**
 * Exercises the stream-visibility half of the store that
 * patches/0004-plotina-persistent-volume.patch adds and
 * patches/0005-plotina-stream-video-toggle.patch extends, under plain node: no
 * node_modules, no browser, no homeserver.
 *
 * tests/test_stream_video_toggle.py applies the whole patch series to the
 * pinned tag, copies the resulting PersistentVolume.ts next to this file and
 * runs it, so what is tested here is the code that ships.
 *
 * Prints one `PASS <name>` or `FAIL <name>: <reason>` line per case and exits
 * non-zero if any of them failed.
 */

import assert from "node:assert/strict";

import {
  ACCOUNT_DATA_TYPE,
  LOCAL_STORAGE_KEY,
  PersistentVolumeStore,
  STREAM_VIDEO_KEY_SUFFIX,
  isStreamVideoKey,
  screenShareVolumeKey,
  streamVideoKey,
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
function fakeClient({ content, user = "@me:example.org", server = null } = {}) {
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

// --- the shape of what is stored -------------------------------------------

test("the stream visibility key is the mxid plus the source", () => {
  assert.equal(streamVideoKey(ALICE), `${ALICE}${STREAM_VIDEO_KEY_SUFFIX}`);
  assert.equal(streamVideoKey(ALICE), `${ALICE}#screenshare-video`);
  assert.equal(isStreamVideoKey(streamVideoKey(ALICE)), true);
  assert.equal(isStreamVideoKey(ALICE), false);
  assert.equal(isStreamVideoKey(screenShareVolumeKey(ALICE)), false);
});

test("a stream is shown until the viewer says otherwise", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  // null means "never chosen", which the ViewModel reads as "show".
  assert.equal(store.getStreamVisible(streamVideoKey(ALICE)), null);
});

test("hiding a stream is remembered", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  const key = streamVideoKey(ALICE);
  store.setStreamVisible(key, false);
  assert.equal(store.getStreamVisible(key), false);
});

test("showing a stream again is remembered", () => {
  const storage = new MemoryStorage();
  const client = fakeClient();
  const store = makeStore({ storage, client: client.client });
  const key = streamVideoKey(ALICE);
  store.setStreamVisible(key, false);
  store.setStreamVisible(key, true);
  assert.equal(store.getStreamVisible(key), true);
});

test("a visibility entry is not read back as a volume", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  const key = streamVideoKey(ALICE);
  store.setStreamVisible(key, false);
  // The audio controls ask for volumes; a visibility entry must not look like
  // one, or hiding a stream would silence its audio too.
  assert.equal(store.get(key), null);
  assert.equal(store.get(ALICE), null);
  assert.equal(store.getStreamVisible(ALICE), null);
});

test("the microphone, the share's audio and its video are separate keys", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  store.set(ALICE, 0.4);
  store.set(screenShareVolumeKey(ALICE), 0.9);
  store.setStreamVisible(streamVideoKey(ALICE), false);
  assert.equal(store.get(ALICE).volume, 0.4);
  assert.equal(store.get(screenShareVolumeKey(ALICE)).volume, 0.9);
  assert.equal(store.getStreamVisible(streamVideoKey(ALICE)), false);
  // Hiding the video left both audio entries exactly as they were.
  assert.deepEqual(store.get(ALICE), { volume: 0.4, muted: false });
  assert.deepEqual(store.get(screenShareVolumeKey(ALICE)), {
    volume: 0.9,
    muted: false,
  });
});

// --- restarts ---------------------------------------------------------------

test("a hidden stream survives a restart", () => {
  const storage = new MemoryStorage();
  const client = fakeClient();
  const key = streamVideoKey(ALICE);
  makeStore({ storage, client: client.client }).setStreamVisible(key, false);
  // A restart is a fresh store reading the same cache.
  assert.equal(
    makeStore({ storage, client: client.client }).getStreamVisible(key),
    false,
  );
});

test("the choice is in both layers", async () => {
  const storage = new MemoryStorage();
  const client = fakeClient();
  const store = makeStore({ storage, client: client.client });
  const key = streamVideoKey(ALICE);
  store.setStreamVisible(key, false);
  assert.ok(String(storage.getItem(LOCAL_STORAGE_KEY)).includes(key));
  await store.flush();
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0][0], ACCOUNT_DATA_TYPE);
  assert.equal(client.writes[0][1][key].visible, false);
});

test("an unchanged choice is neither cached nor synced again", () => {
  const storage = new MemoryStorage();
  const client = fakeClient();
  const store = makeStore({ storage, client: client.client });
  const key = streamVideoKey(ALICE);
  store.setStreamVisible(key, false);
  const writes = storage.writes;
  store.setStreamVisible(key, false);
  assert.equal(storage.writes, writes);
});

// --- two devices ------------------------------------------------------------

test("a visibility change from another device reaches a running call", () => {
  const device = fakeClient();
  const store = makeStore({ storage: new MemoryStorage(), client: device.client });
  const key = streamVideoKey(ALICE);
  let notified = 0;
  store.onChange(key, () => notified++);

  device.emit({ [key]: { visible: false, ts: 2000 } });

  assert.equal(notified, 1);
  assert.equal(store.getStreamVisible(key), false);
});

test("a newer change from another device wins", () => {
  const device = fakeClient();
  const store = makeStore({ storage: new MemoryStorage(), client: device.client });
  const key = streamVideoKey(ALICE);
  store.setStreamVisible(key, false); // ts 1000 locally
  device.emit({ [key]: { visible: true, ts: 5000 } });
  assert.equal(store.getStreamVisible(key), true);
});

test("an older change from another device does not overwrite ours", () => {
  const device = fakeClient();
  const store = makeStore({ storage: new MemoryStorage(), client: device.client });
  const key = streamVideoKey(ALICE);
  store.setStreamVisible(key, false); // ts 1000 locally
  device.emit({ [key]: { visible: true, ts: 999 } });
  assert.equal(store.getStreamVisible(key), false);
});

test("choices for different people are merged, not replaced", () => {
  const device = fakeClient();
  const store = makeStore({ storage: new MemoryStorage(), client: device.client });
  store.setStreamVisible(streamVideoKey(ALICE), false);
  device.emit({ [streamVideoKey(BOB)]: { visible: false, ts: 2000 } });
  assert.equal(store.getStreamVisible(streamVideoKey(ALICE)), false);
  assert.equal(store.getStreamVisible(streamVideoKey(BOB)), false);
});

test("what one device hides is hidden on the other device's next start", async () => {
  const server = {};
  const key = streamVideoKey(ALICE);
  const writer = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient({ server }).client,
  });
  writer.setStreamVisible(key, false);
  // Wait for the debounced account data write to land.
  await writer.flush();
  assert.equal(server.content[key].visible, false);

  // The second device starts with no cache and only what the server has.
  const reader = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient({ content: server.content }).client,
  });
  assert.equal(reader.getStreamVisible(key), false);
});

// --- junk and limits --------------------------------------------------------

test("a visibility entry without a boolean is junk", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient({ content: { [streamVideoKey(ALICE)]: { visible: "no" } } })
      .client,
  });
  assert.equal(store.getStreamVisible(streamVideoKey(ALICE)), null);
});

test("keys that are not a Matrix user id are not stored", () => {
  const storage = new MemoryStorage();
  const store = makeStore({ storage, client: fakeClient().client });
  for (const key of ["alice", "@alice", "@a:b#nonsense", ""]) {
    store.setStreamVisible(key, false);
    assert.equal(store.getStreamVisible(key), null, `accepted ${key}`);
  }
  assert.equal(storage.writes, 0);
});

test("the microphone's key cannot be used to hide a stream", () => {
  const store = makeStore({
    storage: new MemoryStorage(),
    client: fakeClient().client,
  });
  // Only the video suffix names a visibility entry; a bare MXID must not turn
  // into one, or hiding somebody's video would overwrite their volume.
  store.setStreamVisible(ALICE, false);
  assert.equal(store.getStreamVisible(ALICE), null);
  assert.equal(store.get(ALICE), null);
});

test("without an account nothing is remembered", () => {
  const storage = new MemoryStorage();
  const store = makeStore({ storage, client: null });
  store.setStreamVisible(streamVideoKey(ALICE), false);
  assert.equal(store.getStreamVisible(streamVideoKey(ALICE)), null);
  assert.equal(storage.writes, 0);
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