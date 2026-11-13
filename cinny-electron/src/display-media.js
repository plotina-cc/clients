// Display capture policy for the Lite shell.
//
// Chromium asks us for a screen source on every getDisplayMedia(); Element Call
// runs inside a same-origin frame, so both the app origin and the call origin
// must be accepted. We always hand back the whole screen (video only — see the
// audio note in main.js).
//
// The callback must be invoked EXACTLY ONCE per request, whatever happens:
// Chromium keeps a display-media request pending forever if the handler goes
// silent, and while one request is pending every later getDisplayMedia() in the
// same renderer waits behind it (symptom: "Share screen does nothing, no
// picker, until the app is restarted"). A cancelled xdg-desktop-portal
// ScreenCast picker makes desktopCapturer.getSources() reject — that case has
// to end in a deny, not in silence. Same for a source list that never arrives.
'use strict';

// Hard ceiling for one display request. Chromium has none of its own, and a
// portal that never answers (or a picker the user leaves open forever) would
// otherwise wedge every later share attempt.
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Build the `setDisplayMediaRequestHandler` callback.
 *
 * @param {object} deps
 * @param {(opts: object) => Promise<Array<{id: string, name: string}>>} deps.getSources
 *        bound desktopCapturer.getSources
 * @param {(origin: string) => boolean} deps.isOriginAllowed
 * @param {(msg: string) => void} [deps.log]
 * @param {number} [deps.timeoutMs]
 * @returns {(params: object, callback: (selection: object) => void) => Promise<void>}
 */
function createDisplayMediaRequestHandler({ getSources, isOriginAllowed, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const originOf = (url) => {
    try { return new URL(url).origin; } catch { return ''; }
  };

  return function handleDisplayMediaRequest(params, callback) {
    const startedAt = Date.now();
    const origin = originOf(params?.securityOrigin || params?.frame?.url || '');
    let settled = false;
    let timer = null;

    // Single exit point: logs the outcome and answers Chromium once.
    const finish = (selection, outcome) => {
      if (settled) return; // late resolve/reject after a timeout or a second path
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const ms = Date.now() - startedAt;
      const picked = selection && selection.video ? `source=${selection.video.name || selection.video.id}` : 'deny';
      log(`[display-media] ${outcome} origin=${origin || '(none)'} ${picked} in ${ms}ms`);
      try {
        callback(selection || {});
      } catch (e) {
        log(`[display-media] callback threw: ${e && e.message}`);
      }
    };

    if (!isOriginAllowed(origin)) return finish({}, 'denied-origin');

    timer = setTimeout(() => finish({}, 'timeout'), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let pending;
    try {
      pending = getSources({ types: ['screen'] });
    } catch (e) {
      // Synchronous throw (bad state in desktopCapturer) — still answer.
      return finish({}, `sources-threw:${(e && e.name) || 'Error'}`);
    }

    Promise.resolve(pending).then(
      (sources) => {
        if (!sources || !sources.length) return finish({}, 'no-sources');
        finish({ video: sources[0] }, 'granted');
      },
      (e) => {
        // Cancelled portal picker (AbortError / kUserCancelled), portal
        // failure, or anything else: deny, but never leave the request pending.
        // A user cancelling is a normal outcome, not an error — log it as such.
        const name = (e && e.name) || 'Error';
        const kind = name === 'AbortError' ? 'cancel' : 'error';
        finish({}, `sources-${kind}:${name}`);
      },
    );
  };
}

module.exports = { createDisplayMediaRequestHandler, DEFAULT_TIMEOUT_MS };
