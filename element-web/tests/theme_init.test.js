// Node tests for plotina-theme.js — run with:
//   node element-web/tests/theme_init.test.js element-web/plotina-theme.js
// (branding_test.py wires this into element-web/tests/run.sh's unittest suite)
"use strict";

const assert = require("node:assert/strict");
const nodePath = require("node:path");
const {
  firstVisitTheme,
  STORAGE_KEY,
  LIGHT_THEME,
  DARK_THEME,
} = require(nodePath.resolve(process.argv[2]));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("PASS: " + name);
}

// A fake localStorage: initial may be a raw string (a stored blob) or null.
function store(initial) {
  const map = new Map();
  if (initial !== undefined && initial !== null) map.set(STORAGE_KEY, initial);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => map.get(STORAGE_KEY) ?? null,
  };
}
const blob = (o) => JSON.stringify(o);

test("fresh visitor + dark OS gets the dark custom theme", () => {
  const s = store(null);
  assert.equal(firstVisitTheme(s.getItem, s.setItem, true), DARK_THEME);
  assert.deepEqual(JSON.parse(s.dump()), { theme: DARK_THEME });
});

test("fresh visitor + light OS gets the light custom theme", () => {
  const s = store(null);
  assert.equal(firstVisitTheme(s.getItem, s.setItem, false), LIGHT_THEME);
  assert.deepEqual(JSON.parse(s.dump()), { theme: LIGHT_THEME });
});

test("empty string payload counts as fresh", () => {
  const s = store("");
  assert.equal(firstVisitTheme(s.getItem, s.setItem, true), DARK_THEME);
});

test("existing saved theme is never overwritten", () => {
  for (const saved of ["dark", "light", "custom-Plotina Mint"]) {
    const s = store(blob({ theme: saved, use_dark_space: true }));
    assert.equal(firstVisitTheme(s.getItem, s.setItem, true), null);
    assert.equal(s.dump(), blob({ theme: saved, use_dark_space: true }));
  }
});

test("explicit use_system_theme switch is respected (no seeding)", () => {
  for (const v of [true, false]) {
    const s = store(blob({ use_system_theme: v }));
    assert.equal(firstVisitTheme(s.getItem, s.setItem, true), null);
    assert.equal(s.dump(), blob({ use_system_theme: v }));
  }
});

test("other stored settings survive (language blob like prod writes)", () => {
  const s = store(blob({ language: "ru" }));
  assert.equal(firstVisitTheme(s.getItem, s.setItem, true), DARK_THEME);
  assert.deepEqual(JSON.parse(s.dump()), { language: "ru", theme: DARK_THEME });
});

test("unparseable payload is left alone", () => {
  const s = store("{not json at all");
  assert.equal(firstVisitTheme(s.getItem, s.setItem, true), null);
  assert.equal(s.dump(), "{not json at all");
});

test("non-object JSON payloads are left alone", () => {
  for (const raw of ["5", '"text"', "[1,2]", "null"]) {
    const s = store(raw);
    assert.equal(firstVisitTheme(s.getItem, s.setItem, true), null);
    assert.equal(s.dump(), raw);
  }
});

test("empty-string theme counts as unset and is seeded", () => {
  const s = store(blob({ theme: "" }));
  assert.equal(firstVisitTheme(s.getItem, s.setItem, true), DARK_THEME);
  assert.deepEqual(JSON.parse(s.dump()), { theme: DARK_THEME });
});

test("throwing getItem/setItem (blocked storage) is swallowed", () => {
  const boom = () => { throw new Error("SecurityError"); };
  assert.equal(firstVisitTheme(boom, () => {}, true), null);
  assert.equal(firstVisitTheme((k) => null, boom, true), null);
});

test("second run is a no-op (idempotent)", () => {
  const s = store(null);
  firstVisitTheme(s.getItem, s.setItem, true);
  const after1 = s.dump();
  assert.equal(firstVisitTheme(s.getItem, s.setItem, true), null);
  assert.equal(s.dump(), after1);
});

test("theme ids match the custom_themes names in config.json", () => {
  // Read the config next to the script under test, do not hardcode blindly.
  const cfg = JSON.parse(
    require("node:fs").readFileSync(
      nodePath.join(nodePath.dirname(nodePath.resolve(process.argv[2])),
                   "config.json"), "utf8"));
  const ids = cfg.setting_defaults.custom_themes.map((t) => "custom-" + t.name);
  assert.ok(ids.includes(LIGHT_THEME), LIGHT_THEME + " not in " + ids);
  assert.ok(ids.includes(DARK_THEME), DARK_THEME + " not in " + ids);
  const dark = cfg.setting_defaults.custom_themes.find((t) => "custom-" + t.name === DARK_THEME);
  const light = cfg.setting_defaults.custom_themes.find((t) => "custom-" + t.name === LIGHT_THEME);
  assert.equal(dark.is_dark, true);
  assert.equal(light.is_dark, false);
});

console.log("ALL OK (" + passed + " tests)");
