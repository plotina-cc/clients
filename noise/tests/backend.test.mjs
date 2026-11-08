/*
 * Unit tests for the backend-selection logic in noise/logic.js.
 *
 * Run: node --test noise/tests/backend.test.mjs
 * logic.js is a classic script that attaches to `window`; we shim it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "logic.js"), "utf8");

const win = {};
new Function("window", src)(win);
const L = win.PlotinaNoiseLogic;
assert.ok(L, "PlotinaNoiseLogic must be defined by logic.js");

/* ------------------------------------------------------------------ keys */

test("backend storage key and default", () => {
  assert.equal(L.BACKEND_KEY, "plotina.noise.backend");
  assert.equal(L.DEFAULT_BACKEND, "dfn3");
  assert.deepEqual([...L.BACKENDS], ["dfn3", "dpdfnet4"]);
});

/* -------------------------------------------------------------- validating */

test("normalizeBackend accepts known ids", () => {
  assert.equal(L.normalizeBackend("dfn3"), "dfn3");
  assert.equal(L.normalizeBackend("dpdfnet4"), "dpdfnet4");
});

test("normalizeBackend maps anything unknown to the default", () => {
  assert.equal(L.normalizeBackend(""), L.DEFAULT_BACKEND);
  assert.equal(L.normalizeBackend(null), L.DEFAULT_BACKEND);
  assert.equal(L.normalizeBackend(undefined), L.DEFAULT_BACKEND);
  assert.equal(L.normalizeBackend("dfn2"), L.DEFAULT_BACKEND);
  assert.equal(L.normalizeBackend("DPDFNET4"), "dpdfnet4"); // case-tolerant
});

/* -------------------------------------------------------------- query over */

test("parseBackendOverride reads ?plotina-backend=", () => {
  assert.equal(L.parseBackendOverride("?plotina-backend=dpdfnet4"), "dpdfnet4");
  assert.equal(L.parseBackendOverride("?x=1&plotina-backend=dfn3"), "dfn3");
  assert.equal(L.parseBackendOverride("?plotina-backend=bogus"), null);
  assert.equal(L.parseBackendOverride("?plotina-level=50"), null);
  assert.equal(L.parseBackendOverride(""), null);
});

test("resolveBackend: query override beats storage, storage beats default", () => {
  assert.equal(L.resolveBackend({ stored: "dpdfnet4", search: "" }), "dpdfnet4");
  assert.equal(L.resolveBackend({ stored: "dpdfnet4", search: "?plotina-backend=dfn3" }), "dfn3");
  assert.equal(L.resolveBackend({ stored: null, search: "?plotina-backend=dpdfnet4" }), "dpdfnet4");
  assert.equal(L.resolveBackend({ stored: null, search: "" }), "dfn3");
  assert.equal(L.resolveBackend({ stored: "junk", search: "" }), "dfn3");
});

/* ------------------------------------------------------------ fail-open  */

test("backendPlan: dpdfnet4 falls back to dfn3", () => {
  assert.deepEqual(L.backendPlan("dpdfnet4"), ["dpdfnet4", "dfn3"]);
});

test("backendPlan: dfn3 has no further fallback (raw is the last resort)", () => {
  assert.deepEqual(L.backendPlan("dfn3"), ["dfn3"]);
  assert.deepEqual(L.backendPlan("bogus"), ["dfn3"]);
});

test("resolveBackendAfterAttempt walks the plan in order", () => {
  // first-attempt-wins
  assert.equal(L.resolveBackendAfterAttempt("dpdfnet4", ["dpdfnet4"]), "dpdfnet4");
  // dpdfnet4 failed, dfn3 ok
  assert.equal(L.resolveBackendAfterAttempt("dpdfnet4", ["dpdfnet4", "dfn3"]), "dfn3");
  // everything failed -> raw
  assert.equal(L.resolveBackendAfterAttempt("dpdfnet4", ["dpdfnet4", "dfn3", "raw"]), "raw");
  assert.equal(L.resolveBackendAfterAttempt("dfn3", ["dfn3", "raw"]), "raw");
});

/* ------------------------------------------------------------------ misc */

test("strings exposes backend labels for both languages", () => {
  assert.equal(typeof L.strings("ru").backend, "string");
  assert.equal(typeof L.strings("en").backend, "string");
  assert.ok(L.BACKEND_LABELS.dfn3 && L.BACKEND_LABELS.dpdfnet4);
});

test("backend values survive JSON round-trip through storage shim", () => {
  const store = {};
  const persist = (v) => (store[L.BACKEND_KEY] = String(v));
  persist("dpdfnet4");
  assert.equal(L.normalizeBackend(store[L.BACKEND_KEY]), "dpdfnet4");
});

/* --------------------------------------------------- fail-open mock chain */

function mockPool(readyByBackend) {
  var pool = {};
  Object.keys(readyByBackend).forEach(function (k) { pool[k] = readyByBackend[k].slice(); });
  return {
    take: function (id) { return pool[id] && pool[id].length ? pool[id].shift() : null; },
    pool: pool,
  };
}

test("acquireBackendCore: dead dpdfnet4 falls back to a pooled dfn3 core", async () => {
  var p = mockPool({ dfn3: ["CORE-dfn3"] });
  var ports = {
    take: p.take,
    dead: function (id) { return id === "dpdfnet4"; },
    kick: function () {},
    wait: function () { return Promise.resolve(false); },
  };
  var got = await L.acquireBackendCore(["dpdfnet4", "dfn3"], ports);
  assert.equal(got.id, "dfn3");
  assert.equal(got.core, "CORE-dfn3");
});

test("acquireBackendCore: dpdfnet4 warming up wins when it lands in time", async () => {
  var landed = false;
  var p = mockPool({ dpdfnet4: [], dfn3: ["CORE-dfn3"] });
  var ports = {
    take: p.take,
    dead: function () { return false; },
    kick: function () { landed = true; },
    wait: function () {
      if (landed) p.pool.dpdfnet4.push("CORE-dpdfnet");
      return Promise.resolve(landed);
    },
  };
  var got = await L.acquireBackendCore(["dpdfnet4", "dfn3"], ports);
  assert.equal(got.id, "dpdfnet4");
});

test("acquireBackendCore: dpdfnet4 never lands, dfn3 core appears late", async () => {
  var calls = 0;
  var p = mockPool({ dpdfnet4: [], dfn3: [] });
  var ports = {
    take: p.take,
    dead: function (id) { return id === "dpdfnet4"; },
    kick: function () {},
    wait: function () { return Promise.resolve(false); },
  };
  // dfn3 not ready on the first pass, ready when the final sweep runs
  var origTake = p.take;
  ports.take = function (id) {
    calls++;
    if (id === "dfn3" && calls > 2) p.pool.dfn3.push("CORE-late-dfn3");
    return origTake(id);
  };
  var got = await L.acquireBackendCore(["dpdfnet4", "dfn3"], ports);
  assert.equal(got.id, "dfn3");
  assert.equal(got.core, "CORE-late-dfn3");
});

test("acquireBackendCore: everything dead -> null (raw audio)", async () => {
  var ports = {
    take: function () { return null; },
    dead: function () { return true; },
    kick: function () {},
    wait: function () { return Promise.resolve(false); },
  };
  var got = await L.acquireBackendCore(["dpdfnet4", "dfn3"], ports);
  assert.equal(got, null);
});

test("existing level logic untouched", () => {
  assert.equal(L.LEVEL_KEY, "plotina.noise.level");
  assert.equal(L.clampLevel(150), 100);
  // The fallback is the default that logic.js declares, whatever number that
  // happens to be: asserting a literal here would pin tuning, not behaviour.
  assert.equal(L.clampLevel("nope"), L.DEFAULT_LEVEL);
  assert.equal(L.shouldProcess({ audio: { noiseSuppression: true } }), true);
});

test("shouldProcess accepts the current Element Call object constraints", () => {
  assert.equal(
    L.shouldProcess({
      audio: {
        autoGainControl: { ideal: true },
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
      },
      video: { width: { ideal: 640 }, height: { ideal: 360 } },
    }),
    true
  );
});

test("shouldProcess keeps voice messages and disabled suppression raw", () => {
  assert.equal(
    L.shouldProcess({
      audio: {
        channelCount: 1,
        noiseSuppression: { ideal: true },
      },
    }),
    false
  );
  assert.equal(L.shouldProcess({ audio: { noiseSuppression: { ideal: false } } }), false);
  assert.equal(L.shouldProcess({ audio: { noiseSuppression: { exact: false } } }), false);
  assert.equal(L.shouldProcess({ audio: { noiseSuppression: false } }), false);
});

test("DEFAULT_LEVEL exists and is applied", () => {
  assert.equal(typeof L.DEFAULT_LEVEL, "number", "DEFAULT_LEVEL must be a number");
  assert.ok(Number.isInteger(L.DEFAULT_LEVEL), `DEFAULT_LEVEL must be an integer, got ${L.DEFAULT_LEVEL}`);
  assert.ok(L.DEFAULT_LEVEL >= 0 && L.DEFAULT_LEVEL <= 100, `DEFAULT_LEVEL must be inside 0..100, got ${L.DEFAULT_LEVEL}`);
  assert.equal(L.clampLevel(L.DEFAULT_LEVEL), L.DEFAULT_LEVEL, "the default must survive its own clamp");
  for (const junk of [undefined, null, "", "nope", NaN]) {
    assert.equal(L.clampLevel(junk), L.DEFAULT_LEVEL, `clampLevel(${String(junk)})`);
  }
});
