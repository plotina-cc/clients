// T1/T7 — «следуй системной теме» (Element Web 1.12.32, chat.plotina.cc).
//
// Что проверяет: свежий посетитель (пустой localStorage) при
// prefers-color-scheme: dark должен получить ТЁМНЫЙ фон И СВЕТЛЫЙ текст И
// контраст >= 4.5. До фикса падал по всем трём: фон был светлый (Config
// pin'ил светлую custom-тему), а цвет текста наследовался с <html> из-за
// мёртвого var(--timeline-text-color) без fallback в theme-*-custom.css
// (корень и патчи — THEMES.md).
//
// После деплоя ветки theme/css-fallback зелёная целиком:
//   * /plotina-theme.js (init-скрипт) пишет mx_local_settings.theme =
//     "custom-Mint Dark" при тёмной ОС у посетителя без сохранённой
//     темы → фон тёмный;
//   * CSS-патч branding.py даёт тексту fallback на --cpd-color-text-primary,
//     который резолвится по классу cpd-theme-* на body (т.е. по выбранной
//     теме, а не по ОС) → текст светлый на тёмном фоне, контраст ~16.9:1.
// Первый ассерт (seed в localStorage) дополнительно проверяет, что init-тег
// реально вставлен и отрабатывает ДО bundle.js.
//
// Id темы: апстрим собирает его как "custom-" + custom_themes[].name из
// config.json, т.е. id следует за меткой (Mint Light/Mint Dark с 2026-11-08).
// Проба проверяет именно текущий id, поэтому на сборке старше этого
// переименования она останется красной — это ожидаемо, а не регресс.
//
// Как запускать (Playwright настроен в e2e/, браузеры установлены):
//   cd e2e && npm ci
//   cd .. && NODE_PATH=$PWD/e2e/node_modules e2e/node_modules/.bin/playwright test probe-theme.spec.ts
// URL переопределяется переменной окружения PLOTINA_CHAT_URL
// (например http://127.0.0.1:8098/ — локальная симуляция собранного dist).

import { test, expect } from "@playwright/test";

const SITE = process.env.PLOTINA_CHAT_URL ?? "https://chat.plotina.cc/";

// Текущие id custom-тем (config.json: "custom-" + custom_themes[].name).
// Старые "custom-Plotina Mint*" переписаны в эти /plotina-theme.js.
const DARK_THEME_ID = "custom-Mint Dark";

test.describe("system dark theme (fresh visitor)", () => {
  // Никакой авторизации и никакого персистентного состояния: чистый
  // контекст + тёмная системная тема, как у нового посетителя с OS dark.
  test.use({ colorScheme: "dark" });

  test("body gets a dark background and readable light text", async ({ page }) => {
    await page.goto(SITE, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // setTheme() навешивает на <body> класс cpd-theme-*. Ждём именно его,
    // а не просто загрузку — до этого момента токен-слой ещё не применён.
    await page.waitForFunction(
      () => /cpd-theme-(dark|light)/.test(document.body.className),
      undefined,
      { timeout: 60_000 },
    );
    // theme-<...>-custom.css подгружается асинхронно; ждём непустой фон.
    await page.waitForFunction(
      () => getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)",
      undefined,
      { timeout: 20_000 },
    );
    // Страховка от гонки setTheme/disable-цикла (см. THEMES.md): состояние
    // должно простоять неизменным 3 секунды перед замером.
    await page.waitForTimeout(3_000);

    const readout = await page.evaluate(() => {
      const rgbOf = (css: string): [number, number, number] => {
        const m = css.match(/[\d.]+/g);
        return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
      };
      const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const luminance = ([r, g, b]: [number, number, number]) =>
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

      const bs = getComputedStyle(document.body);
      const hs = getComputedStyle(document.documentElement);
      const bgL = luminance(rgbOf(bs.backgroundColor));
      const fgL = luminance(rgbOf(bs.color));
      // Init-скрипт /plotina-theme.js сидит DEVICE-уровневую тему в тот же
      // JSON-блоб mx_local_settings, который реально читает SettingsStore
      // (проверено по init.js чанку: LocalSettingsHandler.getValue →
      // getObject("mx_local_settings")["theme"]; голого ключа "mx_theme"
      // Element не читает).
      let storedTheme: string | null = null;
      try {
        storedTheme = JSON.parse(localStorage.getItem("mx_local_settings") ?? "null")?.theme ?? null;
      } catch {
        storedTheme = null;
      }
      return {
        bodyClass: document.body.className,
        bg: bs.backgroundColor,
        color: bs.color,
        bgLum: bgL,
        textLum: fgL,
        contrast: (Math.max(bgL, fgL) + 0.05) / (Math.min(bgL, fgL) + 0.05),
        storedTheme,
        // Диагностикa корня бага (THEMES.md): цвет body — наследуемое
        // значение с <html>, потому что var(--timeline-text-color) в
        // theme-*-custom.css не определён (IACVT). На <html> он системный:
        htmlColor: hs.color,
        htmlTextPrimary: hs.getPropertyValue("--cpd-color-text-primary").trim(),
        bodyTextPrimary: bs.getPropertyValue("--cpd-color-text-primary").trim(),
        enabledThemeSheets: [...document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")]
          .filter((l) => !l.disabled && l.title)
          .map((l) => l.title),
      };
    });
    console.log("theme readout:", JSON.stringify(readout, null, 2));

    // 0) Тёмная ОС + свежий профиль → init-скрипт должен был засидить
    //    парную ТЁМНУЮ custom-тему до старта бандла (часть 2 фикса).
    expect
      .soft(
        readout.storedTheme,
        `mx_local_settings.theme должен быть ${JSON.stringify(DARK_THEME_ID)} ` +
          `(сид /plotina-theme.js при prefers-color-scheme: dark), сейчас ${JSON.stringify(readout.storedTheme)}`,
      )
      .toBe(DARK_THEME_ID);

    // 1) Фон тёмный (следствие сида: ThemeWatcher применяет Dark-custom).
    expect
      .soft(
        readout.bgLum,
        `prefers-color-scheme: dark → фон body должен быть тёмным, а он ${readout.bg} ` +
          `(luminance ${readout.bgLum.toFixed(3)}; класс ${readout.bodyClass}; активные темы: ${readout.enabledThemeSheets.join(",")})`,
      )
      .toBeLessThan(0.5);

    // 2) Текст светлый — после CSS-фолбэка резолвится по --cpd-color-text-primary
    //    выбранной (тёмной) темы, а не наследуется с <html> от ОС.
    expect
      .soft(
        readout.textLum,
        `текст body должен быть светлым, а он ${readout.color} (luminance ${readout.textLum.toFixed(3)})`,
      )
      .toBeGreaterThan(0.5);

    // 3) Итог: читаемый контраст WCAG AA (после обоих патчей ~16.9:1).
    expect(
      readout.contrast,
      `контраст текст/фон должен быть >= 4.5, сейчас ${readout.contrast.toFixed(2)}:1 ` +
        `(${readout.color} на ${readout.bg}); цвет пришёл наследованием с html=${readout.htmlColor}`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
