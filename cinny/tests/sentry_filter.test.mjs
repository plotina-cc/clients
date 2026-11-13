/*
Copyright 2026 Plotina <thebob3r@gmail.com>

SPDX-License-Identifier: AGPL-3.0-only

Unit tests for the GlitchTip noise filter in our Sentry layer
(patches/0001-plotina-sentry.patch, src/plotina/sentryFilter.ts).

Run through scripts/test-sentry-filter.sh: it exports the pinned upstream tag,
applies cinny/patches/ to it and bundles two entry points with the esbuild that
ships in Cinny's node_modules:

  src/plotina/sentry.ts    the real init, with @sentry/browser aliased to a stub
                           that records the options it is handed, and
                           import.meta.env defined as the CI build defines it
  fakeSentry.ts            the stub, exported next to the init so the tests can
                           read back what Sentry.init received

The tests never copy the filter: they take the beforeSend the real
initPlotinaSentry() installed and feed it events shaped like the ones GlitchTip
really received (metadata.mechanism, minified frames, tags — see the analyst
reports for #70/#71/#72/#73/#74/#75).

Two directions, because a filter is only narrow if it is pinned in both:

  * the six upstream signatures must not reach GlitchTip;
  * a real failure — a render crash, a network failure at login, our own code —
    must still be sent, including the *same* messages from a handled exception.
    A test that only checked the first half would pass for a filter that
    swallowed everything.
*/
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const BUNDLE = process.env.PLOTINA_SENTRY_BUNDLE;
const EMPTY_BUNDLE = process.env.PLOTINA_SENTRY_EMPTY_BUNDLE;
if (!BUNDLE || !EMPTY_BUNDLE) {
  throw new Error(
    'sentry_filter.test.mjs: set PLOTINA_SENTRY_BUNDLE and PLOTINA_SENTRY_EMPTY_BUNDLE ' +
      '(scripts/test-sentry-filter.sh does that)'
  );
}

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/*
The init installs its fetch probe over whatever fetch exists at call time, so
the fake has to be in place before the first initPlotinaSentry(). Every test
below drives requests through it and decides what fetch does by setting
`fetchImpl`.
*/
let fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'));
const requested = [];
globalThis.fetch = function fakeFetch(input, init) {
  requested.push(input);
  return fetchImpl(input, init);
};

const { fake, plotina } = await import(pathToFileURL(BUNDLE).href);
const empty = await import(pathToFileURL(EMPTY_BUNDLE).href);

const MECHANISM = 'auto.browser.global_handlers.onunhandledrejection';

/** An event shaped like the ones GlitchTip received for the six alerts. */
function unhandledRejection(type, value, extra = {}) {
  return {
    event_id: 'a1b2c3d4e5f60718',
    level: 'error',
    platform: 'javascript',
    tags: { client: 'cinny', release: 'cinny@test-release', environment: 'production' },
    exception: {
      values: [
        {
          type,
          value,
          mechanism: { handled: false, type: MECHANISM },
          stacktrace: {
            frames: [
              {
                filename: 'http://127.0.0.1:44548/assets/index-CHwnXAau.js',
                function: 'r',
                lineno: 185,
                colno: 5889,
                in_app: true,
              },
            ],
          },
        },
      ],
    },
    ...extra,
  };
}

/** The same event as an exception Sentry caught in code, not a dead promise. */
function handledException(type, value) {
  const event = unhandledRejection(type, value);
  event.exception.values[0].mechanism = { handled: true, type: 'generic' };
  return event;
}

function beforeSend() {
  return fake.initCalls[0].beforeSend;
}

/* ---------------------------------------------------------------- the wiring */

test('initPlotinaSentry hands the SDK a beforeSend filter and keeps our options', () => {
  plotina.initPlotinaSentry();

  assert.equal(fake.initCalls.length, 1, 'Sentry.init must be called once');
  const options = fake.initCalls[0];

  assert.equal(typeof options.beforeSend, 'function', 'the SDK must receive a beforeSend');
  assert.equal(options.dsn, 'https://public@example.invalid/1');
  assert.equal(options.release, 'cinny@test-release');
  assert.equal(options.environment, 'production');
  assert.equal(options.tracesSampleRate, 0, 'errors only: no tracing');
  assert.equal(options.sendDefaultPii, false);
  assert.deepEqual(options.initialScope, { tags: { client: 'cinny' } });

  // The two integrations that collect console output and URLs stay removed:
  // a Matrix client's breadcrumbs carry room, user and event ids.
  const kept = options.integrations([
    { name: 'Breadcrumbs' },
    { name: 'HttpContext' },
    { name: 'GlobalHandlers' },
  ]);
  assert.deepEqual(kept, [{ name: 'GlobalHandlers' }]);
});

test('the filter is exported as the init installed it, and never throws on junk', () => {
  const send = beforeSend();
  const junk = [undefined, null, 42, 'boom', {}, { exception: null }, { exception: {} }];

  for (const value of junk) {
    assert.equal(send(value), value, `beforeSend must pass ${JSON.stringify(value)} through`);
  }

  // A hostile getter must not turn our filter into an exception of its own.
  const hostile = {
    get exception() {
      throw new Error('boom');
    },
  };
  assert.equal(send(hostile), hostile);

  // Sentry passes a hint; a hostile one is just as inert.
  const handled = handledException('Error', 'Request timed out');
  assert.equal(
    send(
      handled,
      new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        }
      )
    ),
    handled
  );
});

/* ------------------------------------------------------------- what is noise */

test('#70/#74 widget transport timeout is dropped', () => {
  const event = unhandledRejection('Error', 'Request timed out');
  assert.equal(beforeSend()(event), null);
});

test('#71/#75 widget transport "Not ready or unknown widget ID" is dropped', () => {
  const event = unhandledRejection('Error', 'Not ready or unknown widget ID');
  assert.equal(beforeSend()(event), null);
});

test('#73 URL previews disabled (403 is our Synapse config, not a defect) is dropped', () => {
  const event = unhandledRejection(
    'M_FORBIDDEN',
    'MatrixError: [403] URL Previews are disabled (https://plotina.cc/_matrix/client/v1/media/preview_url?url=x&ts=1)'
  );
  assert.equal(beforeSend()(event), null);
});

test('#72 spec-versions fetch failure is dropped once the probe saw the endpoint', async () => {
  const url = 'https://plotina.cc/_matrix/client/versions';
  const error = await globalThis.fetch(url).catch((e) => e);

  assert.ok(requested.includes(url), 'the probe must sit on the real fetch path');
  assert.equal(beforeSend()(unhandledRejection('TypeError', 'Failed to fetch'), {
    originalException: error,
  }), null);
});

/* ---------------------------------------------------- what must still be sent */

test('a network failure at login is still reported', async () => {
  const url = 'https://plotina.cc/_matrix/client/v3/login';
  const error = await globalThis.fetch(url).catch((e) => e);
  const event = unhandledRejection('TypeError', 'Failed to fetch');

  assert.equal(beforeSend()(event, { originalException: error }), event);
});

test('an unannotated "Failed to fetch" is still reported', () => {
  const event = unhandledRejection('TypeError', 'Failed to fetch');
  assert.equal(beforeSend()(event, { originalException: new TypeError('Failed to fetch') }), event);
  assert.equal(beforeSend()(event), event);
});

test('a render crash is still reported', () => {
  const event = unhandledRejection(
    'TypeError',
    "Cannot read properties of undefined (reading 'map')"
  );
  assert.equal(beforeSend()(event), event);
});

test('our own code failing is still reported', () => {
  const event = unhandledRejection('Error', 'plotina: contact-name overlay failed to install');
  assert.equal(beforeSend()(event), event);
});

test('the noise messages as handled exceptions are still reported', () => {
  // The filter is keyed on the dead-promise mechanism, not on the text alone:
  // an exception somebody actually threw reaches GlitchTip.
  for (const [type, value] of [
    ['Error', 'Request timed out'],
    ['Error', 'Not ready or unknown widget ID'],
    ['M_FORBIDDEN', 'MatrixError: [403] URL Previews are disabled (https://x/)'],
    ['TypeError', 'Failed to fetch'],
  ]) {
    const event = handledException(type, value);
    assert.equal(beforeSend()(event), event, `${type}: ${value} must not be dropped`);
  }
});

test('an unhandled rejection with another message is still reported', () => {
  const event = unhandledRejection('Error', 'ConnectionError: fetch failed');
  assert.equal(beforeSend()(event), event);
});

/* -------------------------------------------------------------- the probe */

test('the fetch probe passes requests and responses through untouched', async () => {
  fetchImpl = () => Promise.resolve({ ok: true });
  const before = globalThis.fetch;
  plotina.initPlotinaSentry(); // second init: the probe must not stack
  assert.equal(globalThis.fetch, before, 'the probe must not wrap a second time');

  const response = await globalThis.fetch('https://plotina.cc/_matrix/client/versions');
  assert.deepEqual(response, { ok: true });
});

test('the probe survives an environment without fetch', () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    assert.doesNotThrow(() => plotina.initPlotinaSentry());
  } finally {
    globalThis.fetch = saved;
  }
});

/* ------------------------------------------------------- reporting switched off */

test('no DSN: reporting stays off and nothing is initialised', () => {
  empty.plotina.initPlotinaSentry();
  assert.equal(empty.fake.initCalls.length, 0);
});
