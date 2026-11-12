/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Unit tests for the cc.plotina.set_account_data channel: Element Call sends the
write, the Lite host performs it with ITS MatrixClient.

Two halves, because they fail differently:

  * the frame half (element-call/plotina-account-data.js) runs inside the call
    iframe. matrix-widget-api 1.20 has no write-account-data action and the
    widget's RoomWidgetClient has no access token, so the frame's own
    setAccountData call can only 401. The shim wraps that one method and sends
    the custom action over the widget transport instead -- a custom action is
    the protocol's normal extension point (Element Call already sends
    io.element.join / im.vector.hangup the same way).
  * the host half (src/app/plugins/call/plotinaAccountData.ts) validates the
    payload and writes through the app's client. It must reach the real SDK and
    produce PUT .../account_data/cc.plotina.voice_volumes, and it must never
    write room state (m.room.name, m.room.member).

Run through cinny/scripts/test-lite-calls.sh, which exports the pinned tag,
applies cinny/patches/, bundles the host module with Cinny's own esbuild and
sets PLOTINA_* variables.
*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

const env = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is not set -- run cinny/scripts/test-lite-calls.sh`);
  return value;
};

const loadHost = async () => import(pathToFileURL(env('PLOTINA_ACCOUNT_DATA_HOST')).href);

const TYPE = 'cc.plotina.voice_volumes';

/** A frame window just real enough for the shim: postMessage + widget params. */
const frameWindow = ({ embedded = true, search = '?widgetId=call-embed&parentUrl=http%3A%2F%2F127.0.0.1%3A44548' } = {}) => {
  const listeners = new Set();
  const sent = [];
  const win = {
    sent,
    parent: embedded ? {} : null,
    location: { search, href: `http://127.0.0.1:44548/public/element-call/index.html${search}` },
    postMessage(message, origin) {
      sent.push({ message, origin });
    },
    addEventListener(type, fn) {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'message') listeners.delete(fn);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    reply(message) {
      for (const fn of listeners) fn({ data: message, source: win.parent, origin: 'http://127.0.0.1:44548' });
    },
  };
  win.parent = embedded ? { postMessage: (m) => win.postMessage(m) } : win;
  return win;
};

const loadShim = (win) => {
  const src = readFileSync(env('PLOTINA_ACCOUNT_DATA_SHIM'), 'utf8');
  const context = { window: win, location: win.location, console };
  vm.createContext(context);
  vm.runInContext(src, context, { filename: 'plotina-account-data.js' });
  return context;
};

const fakeClient = () => {
  const calls = [];
  const client = {
    calls,
    async setAccountData(type, content) {
      calls.push([type, content]);
      return {};
    },
  };
  return client;
};

/**
 * The frame's own write path: patch 0004's store calls
 * client.setAccountData(ACCOUNT_DATA_TYPE, map) and nothing else.
 */
test('frame: setAccountData becomes a widget action for cc.plotina types', async () => {
  const win = frameWindow();
  loadShim(win);
  const client = fakeClient();
  win.matrixclient = client;

  const pending = win.matrixclient.setAccountData(TYPE, { '@a:b': { volume: 0.4, ts: 1 } });
  assert.equal(client.calls.length, 0, 'the local client must not be called');

  const [sent] = win.sent;
  assert.equal(sent.message.api, 'fromWidget');
  assert.equal(sent.message.action, 'cc.plotina.set_account_data');
  assert.equal(sent.message.widgetId, 'call-embed');
  assert.equal(sent.message.data.type, TYPE);
  assert.deepEqual(sent.message.data.content, { '@a:b': { volume: 0.4, ts: 1 } });

  win.reply({ api: 'fromWidget', widgetId: 'call-embed', requestId: sent.message.requestId, action: sent.message.action, data: sent.message.data, response: {} });
  await pending;
});

test('frame: a rejected write rejects the caller', async () => {
  const win = frameWindow();
  loadShim(win);
  win.matrixclient = fakeClient();

  const pending = win.matrixclient.setAccountData(TYPE, { a: 1 });
  const [sent] = win.sent;
  win.reply({
    api: 'fromWidget',
    widgetId: 'call-embed',
    requestId: sent.message.requestId,
    action: sent.message.action,
    response: { error: { message: 'refused' } },
  });
  await assert.rejects(pending);
});

test('frame: other account data and room state go to the client untouched', async () => {
  const win = frameWindow();
  loadShim(win);
  const client = fakeClient();
  win.matrixclient = client;

  await win.matrixclient.setAccountData('m.direct', { '@a:b': ['!r:x'] });
  await win.matrixclient.setAccountData('m.room.name', { name: 'x' });
  assert.equal(win.sent.length, 0);
  assert.deepEqual(client.calls.map(([type]) => type), ['m.direct', 'm.room.name']);
});

test('frame: standalone (call.plotina.cc) is not wrapped at all', () => {
  const win = frameWindow({ embedded: false, search: '' });
  loadShim(win);
  const client = fakeClient();
  win.matrixclient = client;
  assert.equal(win.matrixclient, client, 'no wrapper outside a widget');
});

test('host: the write reaches MatrixClient and the account_data endpoint', async () => {
  const { applyAccountDataWrite } = await loadHost();
  const sdk = await import(pathToFileURL(env('PLOTINA_SDK')).href);

  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: String(input.url ?? input), method: init.method ?? 'GET', body: init.body });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{}',
      json: async () => ({}),
    };
  };
  try {
    const mx = sdk.createClient({
      baseUrl: 'https://hs.example',
      accessToken: 'tok',
      userId: '@u:example.org',
    });
    await applyAccountDataWrite(mx, { type: TYPE, content: { '@a:b': { volume: 0.4, ts: 1 } } });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(requests.length, 1, `expected one HTTP write, got ${JSON.stringify(requests)}`);
  assert.equal(requests[0].method, 'PUT');
  assert.match(requests[0].url, /\/account_data\/cc\.plotina\.voice_volumes$/);
  assert.match(requests[0].url, /\/user\/%40u%3Aexample\.org|\/user\/@u:example\.org/);
  assert.equal(JSON.parse(requests[0].body)['@a:b'].volume, 0.4);
});

test('host: room state is never written', async () => {
  const { applyAccountDataWrite } = await loadHost();
  const writes = [];
  const mx = {
    setAccountData: async (type, content) => writes.push([type, content]),
    sendStateEvent: async (roomId, type) => writes.push([roomId, type]),
  };

  for (const type of ['m.room.name', 'm.room.member', 'm.room.topic', 'cc.plotina.contact_names']) {
    await assert.rejects(
      applyAccountDataWrite(mx, { type, content: { name: 'x', membership: 'join' } }),
      `type ${type} must be refused`
    );
  }
  assert.deepEqual(writes, [], 'nothing may be written for a refused type');
});

test('host: junk payloads are refused without a write', async () => {
  const { applyAccountDataWrite } = await loadHost();
  const writes = [];
  const mx = { setAccountData: async (type, content) => writes.push([type, content]) };

  const junk = [
    undefined,
    {},
    { type: TYPE },
    { type: TYPE, content: 'a string' },
    { type: TYPE, content: [1, 2] },
    { type: TYPE, content: null },
    { type: '', content: {} },
  ];
  for (const payload of junk) {
    await assert.rejects(applyAccountDataWrite(mx, payload), JSON.stringify(payload));
  }
  await assert.rejects(
    applyAccountDataWrite(mx, { type: TYPE, content: { pad: 'x'.repeat(70 * 1024) } }),
    'oversized content'
  );
  assert.deepEqual(writes, []);
});
