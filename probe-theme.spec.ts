// T1 — «следуй системной теме» (Element Web 1.12.32, chat.plotina.cc).
//
// Что проверяет: свежий посетитель (пустый localStorage) при
// prefers-color-scheme: dark должен получить ТЁМНЫЙ фон и СВЕТЛЫЙ текст,
// то есть читаемый контраст. Сейчас падает: Element применяет светлый
// custom-theme (Plotina Mint, is_dark:false) к фону, а цвет текста
// наследуется с <html>, чьи compound-токены переключает медиа-запрос
// @media (prefers-color-scheme: dark) в bundle.css. Корень и патч — в
// THEMES.md (раздел «Root cause» и «Минимальный патч»).
//
// Как запускать (Playwright настроен в e2e/, браузеры установлены):
//   cd e2e && npm ci
//   cd .. && NODE_PATH=$PWD/e2e/node_modules e2e/node_modules/.bin/playwright test probe-theme.spec.ts
// URL переопределяется переменной окружения PLOTINA_CHAT_URL.

import { test, expect } from "@playwright/test";

const SITE = process.env.PLOTINA_CHAT_URL ?? "https://chat.plotina.cc/";

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
      return {
        bodyClass: document.body.className,
        bg: bs.backgroundColor,
        color: bs.color,
        bgLum: bgL,
        textLum: fgL,
        contrast: (Math.max(bgL, fgL) + 0.05) / (Math.min(bgL, fgL) + 0.05),
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

    // 1) Фон тёмный: сейчас rgb(255,255,255) — фейл №1, «фон не следует системе».
    expect
      .soft(
        readout.bgLum,
        `prefers-color-scheme: dark → фон body должен быть тёмным, а он ${readout.bg} ` +
          `(luminance ${readout.bgLum.toFixed(3)}; класс ${readout.bodyClass}; активные темы: ${readout.enabledThemeSheets.join(",")})`,
      )
      .toBeLessThan(0.5);

    // 2) Текст светлый — проходит уже сейчас (это и есть вторая половина бага:
    //    светлый текст тёмной темы, но не на тёмном фоне).
    expect
      .soft(
        readout.textLum,
        `текст body должен быть светлым, а он ${readout.color} (luminance ${readout.textLum.toFixed(3)})`,
      )
      .toBeGreaterThan(0.5);

    // 3) Итог: читаемый контраст WCAG AA. Сейчас ~1.05:1 (#ebeef2 на #fff).
    expect(
      readout.contrast,
      `контраст текст/фон должен быть >= 4.5, сейчас ${readout.contrast.toFixed(2)}:1 ` +
        `(${readout.color} на ${readout.bg}); цвет пришёл наследованием с html=${readout.htmlColor}`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});
