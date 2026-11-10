/*
 * Where plotina-dfn.js loads its model from.
 *
 * Element Call runs this file in two very different places:
 *   - on the edge (call.plotina.cc), where the app lives at /room/ and the
 *     wrapper at /noise/plotina-dfn.js, so an absolute /noise path is right;
 *   - inside Element Desktop, which serves the webapp from
 *     vector://vector/webapp/ and the call widget from
 *     vector://vector/webapp/widgets/element-call/. There is no origin root to
 *     point at, so a hard-coded location.origin + "/noise" resolved to
 *     vector://vector/noise/... and the processor never loaded (measured: the
 *     dynamic import failed with "Failed to fetch dynamically imported module").
 *
 * The file therefore derives its base from the script's own URL, exactly like
 * noise/boot.js already does, and falls back to the origin-root path when it
 * cannot see one.
 *
 * Run: node --test noise/tests/dfn-base.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "plotina-dfn.js"), "utf8");

/** Load the classic script with just enough browser surface to run it. */
function load({ scriptSrc, pageUrl }) {
  const url = new URL(pageUrl);
  const noop = () => {};
  const win = {};
  const sandbox = {
    window: win,
    location: {
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    },
    document: { currentScript: scriptSrc ? { src: scriptSrc } : null },
    localStorage: { getItem: () => null, setItem: noop },
    navigator: { sendBeacon: noop },
    fetch: async () => ({ status: 200 }),
    console: { info: noop, warn: noop },
    setTimeout,
    clearTimeout,
    WeakSet,
    Set,
    URL,
    URLSearchParams,
    isFinite,
    Math,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Error,
  };
  sandbox.globalThis = sandbox;
  runInNewContext(src, sandbox);
  return win;
}

test("desktop (vector://) resolves the model next to the script, not at the origin", () => {
  const win = load({
    scriptSrc: "vector://vector/webapp/noise/plotina-dfn.js",
    pageUrl: "vector://vector/webapp/widgets/element-call/index.html",
  });
  assert.equal(win.__plotinaDfnBase, "vector://vector/webapp/noise");
});

test("edge keeps the origin-root path when the script URL is unknown", () => {
  const win = load({
    scriptSrc: null,
    pageUrl: "https://call.plotina.cc/room/",
  });
  assert.equal(win.__plotinaDfnBase, "https://call.plotina.cc/noise");
});

test("edge with a visible script URL resolves from it", () => {
  const win = load({
    scriptSrc: "https://call.plotina.cc/noise/plotina-dfn.js",
    pageUrl: "https://call.plotina.cc/room/",
  });
  assert.equal(win.__plotinaDfnBase, "https://call.plotina.cc/noise");
});

test("a subpath deployment resolves next to the script", () => {
  const win = load({
    scriptSrc: "https://example.org/app/noise/plotina-dfn.js",
    pageUrl: "https://example.org/app/room/",
  });
  assert.equal(win.__plotinaDfnBase, "https://example.org/app/noise");
});
