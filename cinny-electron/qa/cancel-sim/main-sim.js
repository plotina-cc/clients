// QA wrapper app: runs the real Lite shell main.js with the display-capture
// path instrumented, and optionally makes desktopCapturer.getSources fail like
// a cancelled xdg-desktop-portal ScreenCast picker does on Wayland.
//
// Everything here is harness code — src/main.js stays untouched.
//   SIM_CANCEL_AT=2          -> the 2nd getSources call throws AbortError
//   SIM_CANCEL_FROM/TO=n,m   -> a range of calls that fail
//   DM_LOG=0                 -> silence the instrumentation
'use strict';
const electron = require('electron');
const { desktopCapturer, app, session } = electron;

const failAt = Number(process.env.SIM_CANCEL_AT || '0');
const failFrom = Number(process.env.SIM_CANCEL_FROM || '0');
const failTo = Number(process.env.SIM_CANCEL_TO || '0');
const LOG = process.env.DM_LOG !== '0';
let calls = 0;
const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(6, ' ')}ms`;
const say = (...a) => { if (LOG) console.log(stamp(), ...a); };

const origGetSources = desktopCapturer.getSources.bind(desktopCapturer);
const wrapper = async function getSources(opts) {
  calls += 1;
  const n = calls;
  const shouldFail = (failAt && n === failAt) || (failFrom && n >= failFrom && n <= failTo);
  say(`[dm] getSources #${n} enter types=${JSON.stringify(opts?.types)} fail=${shouldFail}`);
  if (shouldFail) {
    const err = new Error('Failed to get sources: ScreenCast session was cancelled (portal Response 1)');
    err.name = 'AbortError';
    say(`[dm] getSources #${n} THROWS ${err.name}: ${err.message}`);
    throw err;
  }
  const list = await origGetSources(opts);
  say(`[dm] getSources #${n} -> ${list.length} source(s): ${list.map((s) => `${s.name}(${s.id})`).join(', ')}`);
  return list;
};
try {
  desktopCapturer.getSources = wrapper;
} catch {
  Object.defineProperty(desktopCapturer, 'getSources', { value: wrapper, configurable: true, writable: true });
}
say('[dm] getSources patched:', desktopCapturer.getSources === wrapper);

process.on('unhandledRejection', (e) => console.log(stamp(), '[dm] UNHANDLED REJECTION: ' + (e && (e.stack || e))));

// Wrap the display-media request handler registered by src/main.js so every
// entry, every callback (and its arguments/timing) is logged.
app.whenReady().then(() => {
  const ds = session.defaultSession;
  const origSet = ds.setDisplayMediaRequestHandler.bind(ds);
  ds.setDisplayMediaRequestHandler = (handler, opts) => {
    say('[dm] setDisplayMediaRequestHandler registered, opts=', JSON.stringify(opts));
    const wrapped = async (params, callback) => {
      const enter = Date.now();
      say(`[dm] handler ENTER origin=${params?.securityOrigin} mediaTypes=${JSON.stringify(params?.mediaTypes)} frame=${String(params?.frame?.url || '').slice(0, 80)}`);
      let done = false;
      const cb = (sel) => {
        done = true;
        say(`[dm] callback after ${Date.now() - enter}ms -> ${JSON.stringify({ keys: sel ? Object.keys(sel) : null, video: !!sel?.video, audio: !!sel?.audio })}`);
        callback(sel);
      };
      try {
        await handler(params, cb);
        if (!done) say(`[dm] handler RETURNED WITHOUT CALLING callback (${Date.now() - enter}ms) — request left pending`);
      } catch (e) {
        say(`[dm] handler THREW after ${Date.now() - enter}ms: ${e && e.name}: ${e && e.message}; callbackCalled=${done}`);
        throw e;
      }
    };
    return origSet(wrapped, opts);
  };
  setTimeout(() => say('[dm] session hook in place (late check):', typeof ds.setDisplayMediaRequestHandler), 1500);
});

require('/home/hermes/work/lite-share-stuck/cinny-electron/src/main.js');
