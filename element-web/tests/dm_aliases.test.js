// Node tests for plotina-dm-aliases.js — run with:
//   node element-web/tests/dm_aliases.test.js element-web/plotina-dm-aliases.js
// (branding_test.py wires this into element-web/tests/run.sh's unittest suite)
//
// Only the pure map handling is covered here: the SDK hook and the DOM need a
// real browser and a Matrix client, which spike-dm-aliases/proof.mjs covers.
"use strict";

const assert = require("node:assert/strict");
const nodePath = require("node:path");
const { ACCOUNT_DATA_TYPE, parseAliases, withAlias } = require(nodePath.resolve(process.argv[2]));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("PASS: " + name);
}

test("account data type is the documented one", () => {
  assert.equal(ACCOUNT_DATA_TYPE, "cc.plotina.room_aliases");
});

test("reads a room_id -> label map", () => {
  const content = { "!abc:example.org": "Денчик", "!def:example.org": "Мама" };
  assert.deepEqual(parseAliases(content), content);
});

test("trims labels and drops empty or non-string values", () => {
  const out = parseAliases({
    "!abc:example.org": "  Денчик  ",
    "!empty:example.org": "   ",
    "!num:example.org": 42,
    "!null:example.org": null,
    "!obj:example.org": { name: "x" },
  });
  assert.deepEqual(out, { "!abc:example.org": "Денчик" });
});

test("ignores keys that are not room ids", () => {
  const out = parseAliases({
    "!abc:example.org": "Денчик",
    "@user:example.org": "not a room",
    "": "empty key",
    "plain": "nope",
  });
  assert.deepEqual(out, { "!abc:example.org": "Денчик" });
});

test("tolerates null, undefined and non-object content", () => {
  for (const bad of [null, undefined, "", "text", 7, []]) {
    assert.deepEqual(parseAliases(bad), {});
  }
});

test("withAlias sets, trims and leaves the input map alone", () => {
  const before = { "!a:x": "one" };
  const next = withAlias(before, "!b:x", "  два  ");
  assert.deepEqual(next, { "!a:x": "one", "!b:x": "два" });
  assert.deepEqual(before, { "!a:x": "one" });
});

test("withAlias replaces an existing label", () => {
  assert.deepEqual(withAlias({ "!a:x": "one" }, "!a:x", "Денчик"),
    { "!a:x": "Денчик" });
});

test("withAlias removes on empty or blank, and never mutates", () => {
  const before = { "!a:x": "one", "!b:x": "two" };
  for (const empty of ["", "   ", null, undefined]) {
    assert.deepEqual(withAlias(before, "!a:x", empty), { "!b:x": "two" });
  }
  assert.deepEqual(before, { "!a:x": "one", "!b:x": "two" });
});

test("withAlias accepts a missing map", () => {
  assert.deepEqual(withAlias(undefined, "!a:x", "Денчик"), { "!a:x": "Денчик" });
});

console.log("ALL OK (" + passed + " tests)");