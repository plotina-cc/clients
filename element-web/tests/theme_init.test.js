// Node tests for plotina-theme.js — run with:
//   node element-web/tests/theme_init.test.js element-web/plotina-theme.js
// (branding_test.py wires this into element-web/tests/run.sh's unittest suite)
"use strict";

const assert = require("node:assert/strict");
const nodePath = require("node:path");
const {
  initTheme,
  firstVisitTheme,
  migrateLegacyTheme,
  STORAGE_KEY,
  LIGHT_THEME,
  DARK_THEME,
  LEGACY_THEMES,
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

// The ids earlier builds wrote into mx_local_settings.theme: our config named
// the themes "Plotina Mint" / "Plotina Mint Dark" before the Mint Light/Mint
// Dark rename, and upstream builds a custom theme id out of the name.
const LEGACY_LIGHT = "custom-Plotina Mint";
const LEGACY_DARK = "custom-Plotina Mint Dark";

function readConfig() {
  return JSON.parse(
    require("node:fs").readFileSync(
      nodePath.join(nodePath.dirname(nodePath.resolve(process.argv[2])),
                   "config.json"), "utf8"));
}
const configIds = () =>
  readConfig().setting_defaults.custom_themes.map((t) => "custom-" + t.name);

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
  for (const saved of ["dark", "light", LIGHT_THEME, DARK_THEME, "custom-Other"]) {
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

// --- legacy id migration ---------------------------------------------------

test("legacy light id is migrated to the current id, other keys kept", () => {
  assert.equal(LEGACY_THEMES[LEGACY_LIGHT], LIGHT_THEME);
  const s = store(blob({ theme: LEGACY_LIGHT, language: "ru", use_dark_space: true }));
  assert.equal(migrateLegacyTheme(s.getItem, s.setItem), LIGHT_THEME);
  assert.deepEqual(JSON.parse(s.dump()),
                   { theme: LIGHT_THEME, language: "ru", use_dark_space: true });
});

test("legacy dark id is migrated to the current id", () => {
  assert.equal(LEGACY_THEMES[LEGACY_DARK], DARK_THEME);
  const s = store(blob({ theme: LEGACY_DARK }));
  assert.equal(migrateLegacyTheme(s.getItem, s.setItem), DARK_THEME);
  assert.deepEqual(JSON.parse(s.dump()), { theme: DARK_THEME });
});

test("migration leaves current and built-in themes untouched", () => {
  for (const saved of ["dark", "light", LIGHT_THEME, DARK_THEME, "custom-Other"]) {
    const initial = blob({ theme: saved });
    const s = store(initial);
    assert.equal(migrateLegacyTheme(s.getItem, s.setItem), null);
    assert.equal(s.dump(), initial);
  }
});

test("migration ignores a missing, empty or non-string theme", () => {
  for (const value of [{}, { theme: "" }, { theme: 5 }, { use_system_theme: true }]) {
    const initial = blob(value);
    const s = store(initial);
    assert.equal(migrateLegacyTheme(s.getItem, s.setItem), null);
    assert.equal(s.dump(), initial);
  }
});

test("migration is idempotent", () => {
  const s = store(blob({ theme: LEGACY_DARK }));
  assert.equal(migrateLegacyTheme(s.getItem, s.setItem), DARK_THEME);
  const after1 = s.dump();
  assert.equal(migrateLegacyTheme(s.getItem, s.setItem), null);
  assert.equal(s.dump(), after1);
});

test("migration leaves a payload it cannot parse alone", () => {
  for (const raw of ["{not json", "5", '"text"', "[1,2]", "null"]) {
    const s = store(raw);
    assert.equal(migrateLegacyTheme(s.getItem, s.setItem), null);
    assert.equal(s.dump(), raw);
  }
});

test("migration swallows a blocked storage", () => {
  const boom = () => { throw new Error("SecurityError"); };
  assert.equal(migrateLegacyTheme(boom, () => {}), null);
  assert.equal(migrateLegacyTheme((k) => null, boom), null);
});

test("initTheme migrates an existing user instead of seeding", () => {
  const s = store(blob({ theme: LEGACY_LIGHT }));
  assert.equal(initTheme(s.getItem, s.setItem, true), null);
  assert.deepEqual(JSON.parse(s.dump()), { theme: LIGHT_THEME });
});

test("initTheme still seeds a fresh visitor", () => {
  const s = store(null);
  assert.equal(initTheme(s.getItem, s.setItem, true), DARK_THEME);
  assert.deepEqual(JSON.parse(s.dump()), { theme: DARK_THEME });
});

// --- the three sources must agree ------------------------------------------
// config.json carries the ids (custom_themes names, default_theme,
// setting_defaults.theme) and this script carries the ids it seeds/migrates.
// The suite fails when they drift apart — which is how the Plotina Mint ->
// Mint Light rename left the seeded id pointing at a theme that did not exist.

test("theme ids match the custom_themes names in config.json", () => {
  const ids = configIds();
  assert.ok(ids.includes(LIGHT_THEME), LIGHT_THEME + " not in " + ids);
  assert.ok(ids.includes(DARK_THEME), DARK_THEME + " not in " + ids);
  const themes = readConfig().setting_defaults.custom_themes;
  const dark = themes.find((t) => "custom-" + t.name === DARK_THEME);
  const light = themes.find((t) => "custom-" + t.name === LIGHT_THEME);
  assert.equal(dark.is_dark, true);
  assert.equal(light.is_dark, false);
});

test("default_theme and setting_defaults.theme point at a defined theme", () => {
  const cfg = readConfig();
  const ids = configIds();
  assert.equal(cfg.default_theme, LIGHT_THEME);
  assert.equal(cfg.setting_defaults.theme, LIGHT_THEME);
  assert.ok(ids.includes(cfg.default_theme), cfg.default_theme + " not in " + ids);
  assert.ok(ids.includes(cfg.setting_defaults.theme),
            cfg.setting_defaults.theme + " not in " + ids);
});

test("legacy ids are migrated and no longer live ids in config.json", () => {
  const ids = configIds();
  for (const legacy of [LEGACY_LIGHT, LEGACY_DARK]) {
    assert.ok(Object.prototype.hasOwnProperty.call(LEGACY_THEMES, legacy),
              legacy + " is missing from the migration map");
    assert.ok(!ids.includes(legacy), legacy + " is still a live id in config.json");
  }
});

console.log("ALL OK (" + passed + " tests)");