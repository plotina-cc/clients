// Unit tests for the shell's display-capture policy (src/display-media.js).
//
// The defect these pin down: a display request whose source list never arrives
// (cancelled xdg-desktop-portal ScreenCast picker, portal error, hung
// desktopCapturer) used to leave Chromium's pending getDisplayMedia request
// unanswered. Chromium never expires that request itself, so every later
// getDisplayMedia in the same app run waited forever — the user sees "nothing
// happens, no picker" until the app is restarted.
//
// Pure node, no Electron:  node tests/display-media.test.mjs
'use strict';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDisplayMediaRequestHandler } = require('../src/display-media.js');

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };
const allowAll = () => true;
const allowOnly = (origin) => origin === 'https://app.example';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Records every callback invocation: [{selection, at}]. */
function recorder() {
  const calls = [];
  const callback = (selection) => calls.push({ selection, at: Date.now() });
  return { calls, callback };
}

// ---------------------------------------------------------------- D1 happy path
await t('D1 allowed origin gets one whole-screen source (video only)', async () => {
  const rec = recorder();
  const handler = createDisplayMediaRequestHandler({
    getSources: async () => [{ id: 'screen:0:0', name: 'Entire screen' }],
    isOriginAllowed: allowAll,
  });
  await handler({ securityOrigin: 'https://app.example', mediaTypes: ['video', 'audio'] }, rec.callback);
  await tick(0);
  assert.strictEqual(rec.calls.length, 1, 'callback must fire exactly once');
  const sel = rec.calls[0].selection;
  assert.ok(sel.video, 'video source must be returned');
  assert.strictEqual(sel.video.name, 'Entire screen');
  assert.strictEqual(sel.audio, undefined, 'audio is never returned (EC audio constraint bug)');
});

// ------------------------------------------------- D2..D3 cancelled picker
await t('D2 cancelled picker still answers the request (deny, not silence)', async () => {
  const rec = recorder();
  const handler = createDisplayMediaRequestHandler({
    getSources: async () => { const e = new Error('ScreenCast session was cancelled (portal Response 1)'); e.name = 'AbortError'; throw e; },
    isOriginAllowed: allowAll,
  });
  await handler({ securityOrigin: 'https://app.example', mediaTypes: ['video'] }, rec.callback);
  await tick(0);
  assert.strictEqual(rec.calls.length, 1, 'a cancelled request must complete the callback once, or Chromium keeps it pending forever');
  assert.deepStrictEqual(rec.calls[0].selection, {}, 'cancellation is a deny, not a bogus source');
});

await t('D3 the request after a cancelled one still gets a source', async () => {
  let call = 0;
  const rec = recorder();
  const handler = createDisplayMediaRequestHandler({
    getSources: async () => {
      call += 1;
      if (call === 1) { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
      return [{ id: 'screen:0:0', name: 'Entire screen' }];
    },
    isOriginAllowed: allowAll,
  });
  await handler({ securityOrigin: 'https://app.example' }, rec.callback);
  await tick(0);
  await handler({ securityOrigin: 'https://app.example' }, rec.callback);
  await tick(0);
  assert.strictEqual(rec.calls.length, 2, 'the second request must be answered too');
  assert.deepStrictEqual(rec.calls[0].selection, {}, 'first (cancelled) is a deny');
  assert.ok(rec.calls[1].selection.video, 'second request shares normally');
});

// ----------------------------------------------------------- D4 empty list
await t('D4 no sources -> deny once, no throw', async () => {
  const rec = recorder();
  const handler = createDisplayMediaRequestHandler({
    getSources: async () => [],
    isOriginAllowed: allowAll,
  });
  await handler({ securityOrigin: 'https://app.example' }, rec.callback);
  await tick(0);
  assert.strictEqual(rec.calls.length, 1);
  assert.deepStrictEqual(rec.calls[0].selection, {});
});

// ------------------------------------------------------- D5 hung source list
await t('D5 a getSources that never settles still answers within the timeout', async () => {
  const rec = recorder();
  const handler = createDisplayMediaRequestHandler({
    getSources: () => new Promise(() => {}), // portal never replies
    isOriginAllowed: allowAll,
    timeoutMs: 40,
  });
  await handler({ securityOrigin: 'https://app.example' }, rec.callback);
  await tick(120);
  assert.strictEqual(rec.calls.length, 1, 'a hung source list must not leave the request pending until app exit');
  assert.deepStrictEqual(rec.calls[0].selection, {}, 'timeout is a deny');
});

// ------------------------------------------- D6 exactly once, even when late
await t('D6 a source list arriving after the timeout does not call back twice', async () => {
  const rec = recorder();
  let resolveSources;
  const handler = createDisplayMediaRequestHandler({
    getSources: () => new Promise((res) => { resolveSources = res; }),
    isOriginAllowed: allowAll,
    timeoutMs: 30,
  });
  await handler({ securityOrigin: 'https://app.example' }, rec.callback);
  await tick(80);
  assert.strictEqual(rec.calls.length, 1, 'timeout already answered');
  resolveSources([{ id: 'screen:0:0', name: 'Entire screen' }]);
  await tick(30);
  assert.strictEqual(rec.calls.length, 1, 'late resolution must not invoke the callback again');
});

// ------------------------------------------------ D8 cancel is logged as cancel
await t('D8 a cancelled picker is logged as a cancel, not as an error', async () => {
  const rec = recorder();
  const lines = [];
  const handler = createDisplayMediaRequestHandler({
    getSources: async () => { const e = new Error('Failed to get sources.'); e.name = 'AbortError'; throw e; },
    isOriginAllowed: allowAll,
    log: (m) => lines.push(m),
  });
  await handler({ securityOrigin: 'https://app.example' }, rec.callback);
  await tick(0);
  assert.strictEqual(rec.calls.length, 1);
  const line = lines.join('\n');
  assert.match(line, /sources-cancel:AbortError/, 'cancel must be distinguishable from a real failure');
  assert.match(line, /deny/, 'the outcome is a deny');
});

// ---------------------------------------------------------- D9 origin allowlist
await t('D9 a foreign origin is denied without touching desktopCapturer', async () => {
  const rec = recorder();
  let asked = 0;
  const handler = createDisplayMediaRequestHandler({
    getSources: async () => { asked += 1; return [{ id: 'screen:0:0', name: 'Entire screen' }]; },
    isOriginAllowed: allowOnly,
  });
  await handler({ securityOrigin: 'https://evil.example' }, rec.callback);
  await tick(0);
  assert.strictEqual(asked, 0, 'no source enumeration for a foreign origin');
  assert.strictEqual(rec.calls.length, 1);
  assert.deepStrictEqual(rec.calls[0].selection, {});
});

console.log(`\n${n} display-media checks passed`);
