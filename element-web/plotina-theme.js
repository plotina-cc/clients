/* Plotina Web — first-visit theme bootstrap (THEMES.md, part 2).
 *
 * Element's ThemeWatcher can only follow prefers-color-scheme for the
 * *built-in* light/dark themes; custom themes are exempt upstream
 * (element-hq/element-web#34948), and our config pins setting_defaults.theme
 * to "custom-Plotina Mint", so a dark-OS visitor gets the light custom theme.
 * This script runs before the bundle loader (bundles/<hash>/bundle.js;
 * branding.py injects the tag)
 * and seeds the same storage Element itself reads at the DEVICE level:
 * the "mx_local_settings" JSON blob, whose "theme" key is picked up by
 * SettingsStore.getValue("theme") as an explicit value — verified against
 * the live v1.12.32 init.js chunk (LocalSettingsHandler:
 * `getValue` = `(getSettings()||{})[e]`, `getSettings` =
 * `getObject("mx_local_settings")`). A bare "mx_theme" key is NOT read.
 *
 * Contract:
 *   - fresh visitor (no "theme", no "use_system_theme" in the blob):
 *     dark OS  -> mx_local_settings.theme = "custom-Plotina Mint Dark"
 *     light OS -> mx_local_settings.theme = "custom-Plotina Mint"
 *     (theme ids must match setting_defaults.custom_themes names in
 *     config.json, prefixed with "custom-" — what ThemeWatcher hands to
 *     setTheme()).
 *   - anyone with a stored theme or an explicit use_system_theme switch is
 *     left byte-identical, and so is any blob this script cannot parse.
 *   - a user changing the theme in Settings overwrites the seeded value;
 *     this only decides the default on a clean profile.
 */
(function (root) {
  "use strict";

  var STORAGE_KEY = "mx_local_settings";
  var LIGHT_THEME = "custom-Plotina Mint";
  var DARK_THEME = "custom-Plotina Mint Dark";

  /**
   * Seed the first-visit theme. Returns the theme id written, or null when
   * nothing was touched (existing user, unreadable payload, storage error).
   * Pure function of (getItem, setItem, prefersDark) so node can test it.
   */
  function firstVisitTheme(getItem, setItem, prefersDark) {
    var raw;
    try {
      raw = getItem(STORAGE_KEY);
    } catch (err) {
      return null; // blocked/throwing storage: let Element's own default apply
    }
    var settings;
    if (raw === null || raw === undefined || raw === "") {
      settings = {};
    } else {
      try {
        settings = JSON.parse(raw);
      } catch (err) {
        return null; // not JSON we may rewrite: do not destroy someone's payload
      }
      if (settings === null || typeof settings !== "object" ||
          Array.isArray(settings)) {
        return null;
      }
    }
    if (typeof settings.theme === "string" && settings.theme.length > 0) {
      return null; // existing user: their saved theme wins
    }
    if (Object.prototype.hasOwnProperty.call(settings, "use_system_theme")) {
      return null; // explicit follow-system switch: Element decides
    }
    settings.theme = prefersDark ? DARK_THEME : LIGHT_THEME;
    try {
      setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      return null;
    }
    return settings.theme;
  }

  // CommonJS export for element-web/tests/theme_init.test.js (node).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      firstVisitTheme: firstVisitTheme,
      STORAGE_KEY: STORAGE_KEY,
      LIGHT_THEME: LIGHT_THEME,
      DARK_THEME: DARK_THEME
    };
  }

  // Browser entry point. This file is served from /app and loaded before
  // the bundle loader, synchronously, so Element sees the seed on its very
  // first SettingsStore read.
  if (root && root.localStorage && root.matchMedia) {
    firstVisitTheme(
      function (key) { return root.localStorage.getItem(key); },
      function (key, value) { root.localStorage.setItem(key, value); },
      root.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }
})(typeof window !== "undefined" ? window : this);
