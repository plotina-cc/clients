/* Plotina Web — theme bootstrap (THEMES.md, part 2).
 *
 * Element's ThemeWatcher can only follow prefers-color-scheme for the
 * *built-in* light/dark themes; custom themes are exempt upstream
 * (element-hq/element-web#34948), and our config pins setting_defaults.theme
 * to the light custom theme, so a dark-OS visitor gets the light custom theme.
 * This script runs before the bundle loader (bundles/<hash>/bundle.js;
 * branding.py injects the tag)
 * and seeds the same storage Element itself reads at the DEVICE level:
 * the "mx_local_settings" JSON blob, whose "theme" key is picked up by
 * SettingsStore.getValue("theme") as an explicit value — verified against
 * the live v1.12.32 init.js chunk (LocalSettingsHandler:
 * `getValue` = `(getSettings()||{})[e]`, `getSettings` =
 * `getObject("mx_local_settings")`). A bare "mx_theme" key is NOT read.
 *
 * Theme ids: upstream derives a custom theme's id as "custom-" + its
 * setting_defaults.custom_themes[].name in config.json (there is no separate
 * id field), so the label *is* the id. Ours are named "Mint Light" /
 * "Mint Dark" -> "custom-Mint Light" / "custom-Mint Dark".
 *
 * Contract:
 *   - legacy id migration (runs first, for every visitor): a saved
 *     mx_local_settings.theme of "custom-Plotina Mint" / "custom-Plotina Mint
 *     Dark" (the ids our config carried before the Mint Light/Mint Dark
 *     rename) is rewritten to the matching current id. Without this the
 *     stored value points at a theme that no longer exists in config.json and
 *     Element cannot resolve it. The rest of the blob is preserved.
 *   - fresh visitor (no "theme", no "use_system_theme" in the blob):
 *     dark OS  -> mx_local_settings.theme = "custom-Mint Dark"
 *     light OS -> mx_local_settings.theme = "custom-Mint Light"
 *     (theme ids must match setting_defaults.custom_themes names in
 *     config.json, prefixed with "custom-" — what ThemeWatcher hands to
 *     setTheme()).
 *   - anyone with a stored theme (other than a legacy id above) or an
 *     explicit use_system_theme switch is left byte-identical, and so is any
 *     blob this script cannot parse.
 *   - a user changing the theme in Settings overwrites the seeded value;
 *     this only decides the default on a clean profile.
 */
(function (root) {
  "use strict";

  var STORAGE_KEY = "mx_local_settings";
  var LIGHT_THEME = "custom-Mint Light";
  var DARK_THEME = "custom-Mint Dark";

  // Ids that earlier builds of this config wrote into mx_local_settings.theme,
  // mapped to their current equivalent (same colours, is_dark and Compound
  // tokens — only the name, and therefore the id, changed).
  var LEGACY_THEMES = {
    "custom-Plotina Mint": LIGHT_THEME,
    "custom-Plotina Mint Dark": DARK_THEME
  };

  /**
   * Read the mx_local_settings blob. Returns the parsed object (an empty one
   * for an absent/empty payload), or null when the payload is not a JSON
   * object we may rewrite — never destroy someone's data.
   */
  function loadSettings(getItem) {
    var raw;
    try {
      raw = getItem(STORAGE_KEY);
    } catch (err) {
      return null; // blocked/throwing storage: let Element's own default apply
    }
    if (raw === null || raw === undefined || raw === "") {
      return {};
    }
    var settings;
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      return null; // not JSON we may rewrite
    }
    if (settings === null || typeof settings !== "object" ||
        Array.isArray(settings)) {
      return null;
    }
    return settings;
  }

  /** Persist the blob. Returns false when storage refused the write. */
  function storeSettings(setItem, settings) {
    try {
      setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      return false;
    }
    return true;
  }

  /**
   * Rewrite a legacy saved theme id to the current one. Returns the id now
   * stored, or null when nothing was touched (no legacy value, unreadable
   * payload, storage error). Pure function of (getItem, setItem).
   */
  function migrateLegacyTheme(getItem, setItem) {
    var settings = loadSettings(getItem);
    if (settings === null) {
      return null;
    }
    if (typeof settings.theme !== "string" ||
        !Object.prototype.hasOwnProperty.call(LEGACY_THEMES, settings.theme)) {
      return null; // nothing to migrate: unset, empty, or already current
    }
    settings.theme = LEGACY_THEMES[settings.theme];
    if (!storeSettings(setItem, settings)) {
      return null;
    }
    return settings.theme;
  }

  /**
   * Seed the first-visit theme. Returns the theme id written, or null when
   * nothing was touched (existing user, unreadable payload, storage error).
   * Pure function of (getItem, setItem, prefersDark) so node can test it.
   */
  function firstVisitTheme(getItem, setItem, prefersDark) {
    var settings = loadSettings(getItem);
    if (settings === null) {
      return null;
    }
    if (typeof settings.theme === "string" && settings.theme.length > 0) {
      return null; // existing user: their saved theme wins
    }
    if (Object.prototype.hasOwnProperty.call(settings, "use_system_theme")) {
      return null; // explicit follow-system switch: Element decides
    }
    settings.theme = prefersDark ? DARK_THEME : LIGHT_THEME;
    if (!storeSettings(setItem, settings)) {
      return null;
    }
    return settings.theme;
  }

  /**
   * Boot entry point: migrate a legacy id first, then seed a fresh profile.
   * Returns whatever firstVisitTheme returns (null for anyone who already had
   * a theme, including one just migrated).
   */
  function initTheme(getItem, setItem, prefersDark) {
    migrateLegacyTheme(getItem, setItem);
    return firstVisitTheme(getItem, setItem, prefersDark);
  }

  // CommonJS export for element-web/tests/theme_init.test.js (node).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      initTheme: initTheme,
      firstVisitTheme: firstVisitTheme,
      migrateLegacyTheme: migrateLegacyTheme,
      STORAGE_KEY: STORAGE_KEY,
      LIGHT_THEME: LIGHT_THEME,
      DARK_THEME: DARK_THEME,
      LEGACY_THEMES: LEGACY_THEMES
    };
  }

  // Browser entry point. This file is served from /app and loaded before
  // the bundle loader, synchronously, so Element sees the seed on its very
  // first SettingsStore read.
  if (root && root.localStorage && root.matchMedia) {
    initTheme(
      function (key) { return root.localStorage.getItem(key); },
      function (key, value) { root.localStorage.setItem(key, value); },
      root.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }
})(typeof window !== "undefined" ? window : this);