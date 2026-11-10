# THEMES.md — корень бага «следуй системной теме» в Plotina Element Web 1.12.32

Исследование от 2026-11-05. Ничего не патчено в коде и брендинге: здесь — диагноз,
точный механизм, минимальный find/replace для `element-web/branding.py` и красная
Playwright-проба (`probe-theme.spec.ts` в этом же корне worktree).

## TL;DR

Симптом «при `prefers-color-scheme: dark` фон белый, а текст — светлый» — это **не**
ошибка `ThemeController`/`use_system_theme`: контронер отрабатывает штатно и ставит
на `<body>` configured light-тему (`cpd-theme-light`, активен лист `Light-custom`).
Ломается каскад CSS в **`theme-light-custom.css` / `theme-dark-custom.css`**: их
правило для `body` (и ещё 132 селектора) пишет `color:var(--timeline-text-color)` —
а переменная `--timeline-text-color` **нигде не определена** (легаси-токен, мёртвый
во всей поставке). Объявление с несуществующей переменной без fallback становится
*invalid at computed-value time* → `color` превращается в `inherit` → body наследует
цвет с `<html>`. На `<html>` классов `cpd-theme-*` Element не вешает никогда, и
`bundle.css` содержит compound-токены, переключённые прямо по системному медиа-запросу
`@media (prefers-color-scheme: dark){:root{--cpd-color-gray-1400:#ebeef2;…}}`.
Итог: фон резолвится по выбранной (светлой) теме — у `background-color` fallback
есть (`var(--timeline-background-color,var(--cpd-color-bg-canvas-default))`), — а
текст резолвится по ОС. Dark-ОС + светлая тема = `#ebeef2` на белом, контраст 1.16:1.
На light-ОС тот же мусор выглядит «правильно» случайно (наследуется `#1b1d22`),
поэтому баг воспроизводится только при системном dark (зеркально ломается
тёмная custom-тема на светлой ОС).

## 1._assets_ и идентификаторы (chat.plotina.cc, bundle `81bff4fd060173d686ec`)

`index.html` грузит только загрузчик `bundles/81bff4fd060173d686ec/bundle.js` (27 KB,
webpack runtime). Карта чанков в загрузчике (`bundle.js`, `.u=`):

| chunk id | имя | роль |
|---|---|---|
| 2702 | `element-web-app.js` | UI приложения (1.36 MB), дропдаун темы, Settings |
| 5385 | `init.js` | bootstrap + **`./src/theme.ts`** + **`./src/settings/watchers/ThemeWatcher.ts`** (1.12 MB) |
| 6312 | `6312.js` | общий vendor-чанк (импортирует theme/ThemeWatcher) |
| 1869 | `styles.js`/`styles.css` | ленивые стили |
| — | `bundle.css` | **compound-токены + базовые стили, всегда подключён** |
| — | `theme-light.css`, `theme-dark.css`, `theme-light-custom.css`, `theme-dark-custom.css`, `theme-legacy-*.css` | листы тем, `link[title]`, включаются/disabled'ятся из JS |

Ключевые модули/функции в минифицированном `init.js` (смещения для данного билда):

* `./src/settings/watchers/ThemeWatcher.ts` @ ~228210 — класс `h`:
  * `this.preferDark=n.g.matchMedia("(prefers-color-scheme: dark)")`, `preferLight`, `preferHighContrast` — вочеры;
  * `getEffectiveTheme()` — порядок: явный `use_system_theme` (DEVICE, asExplicit) → явный `theme` → дефолтный `use_system_theme` (`themeBasedOnSystem()` → `"dark"`/`"light"`) → дефолтный `theme`;
  * `themeBasedOnSystem()` возвращает **только встроенные** id `light`/`dark`/HC — custom-темы «следуй системе» не умеют в упор (апстрим element-hq/element-web#34948);
  * `isUserOnDarkTheme()` — для `custom-*` читает `is_dark` из `custom_themes` (`c.TP` = `getCustomTheme`).
* `./src/theme.ts` @ ~263890:
  * `w` = `setTheme(theme)`: для `custom-X` → `b("X").is_dark ? "dark-custom" : "light-custom"` (включает соответствующий `link[data-mx-theme]`), чистит inline-переменные body, ставит на **body** `cpd-theme-light|dark(-hc)`;
  * `y` = `applyCustomTheme`: inline `--accent-color/--primary-color` на body + `<style title="custom-theme-compound">` с **только теми** compound-токенами, что перечислены в `config.json` (у нас 3 акцентных), в `@layer compound-tokens` на селекторе `:root,[class*="cpd-theme-"]`.
* `element-web-app.js` @ ~432872 — хук `ph()` выбора темы (`use_system_theme`/`theme` из SettingsStore) и ~1048596 — панель Appearance (`isDark: (custom.is_dark ?? id.includes("dark"))`).

## 2. Экспериментальные факты (Chromium 1194 через Playwright, свежий контекст, `colorScheme:'dark'`)

| момент | class body | bg | color | активные title-листы |
|---|---|---|---|---|
| DOMContentLoaded | — | `#101317` | `#ebeef2` | bundle.css, styles.css (всё системно-тёмное по `:root`-медиа) |
| +8.4 c (setTheme отработал) | `cpd-theme-light` | `#fff` | `#1b1d22` ✓ | + Light-custom |
| +10.3 c (финал, стабилен) | `cpd-theme-light` | `#fff` | **`#ebeef2` ✗** | Light-custom |

Финальное состояние (нечитаемое) держится неограниченно. `localStorage` пуст
(`mx-theme`, `mx-use_system_theme` — null): проба действительно про «свежий профиль».

Диагностика каскада на финальном состоянии:

* вычисляемые **токены** на body корректно светлые: `--cpd-color-text-primary: #1b1d22`,
  `--cpd-color-bg-canvas-default: #fff` (правило `.cpd-theme-light.cpd-theme-light` в bundle.css);
* на `<html>` (нет класса темы) те же токены равны тёмным: `#ebeef2`/`#101317` — их
  задаёт `@media screen and (prefers-color-scheme: dark){@layer cpd-base{:root{--cpd-color-theme-bg:#101317;--cpd-color-gray-1400:#ebeef2;…}}}` (bundle.css @ ~180538) плюс семантика
  `@layer cpd-semantic{:root,[class*=cpd-theme-]{--cpd-color-text-primary:var(--cpd-color-gray-1400);…}}` (@114099);
* rules, матящиеся body и задающие `color`:
  1. `body,html,input{color:var(--cpd-color-text-primary)}` (bundle.css)
  2. **`body{color:var(--timeline-text-color)}` (theme-light-custom.css @ 3299)** — выигрывает, но var не определён → IACVT → `inherit`;
* `--timeline-text-color` не определён **нигде**: по всем CSS/JS чанкам 0 определений,
  133 использования без fallback в каждом из двух custom-листов; для
  `--timeline-background-color` — 66 использований, **все с fallback**. Отсюда и
  асимметрия «фон светлый, текст тёмно-токеновый».
* консоль страницы: `returning explicit theme: custom-Plotina Mint` — ThemeWatcher
  считает `setting_defaults.theme` явным DEVICE-значением и до ветки
  `themeBasedOnSystem()` вообще не доходит. Медиа-вочер (`preferDark`) при этом жив и
  корректно игнорируется — это ожидаемое поведение явной темы.

Тот же механизм объясняет, почему light-ОС «не сломана»: `html` тогда `#1b1d22`,
и наследование даёт читаемый тёмный текст на белом. Ошибка молча зеркальна:
`custom-Plotina Mint Dark` + светлая ОС = тёмный фон + унаследованный тёмный текст.

## 3. Минимальный патч (для `element-web/branding.py`, конвейер как у error-view)

Два файла в готовом dist: `bundles/<hash>/theme-light-custom.css` и
`bundles/<hash>/theme-dark-custom.css`. Одна замена во всех 133 местах каждого:

```text
FIND:    var(--timeline-text-color)
REPLACE: var(--timeline-text-color,var(--cpd-color-text-primary))
```

Fallback — родственный токен из той же каскадной связки: на body он резолвится по
классу `cpd-theme-*` (выбранной теме), а не по ОС; если когда-нибудь `--timeline-text-color`
снова определят легаси-листовой — он, как обычно, победит. Точная байтовая опора
первого вхождения в minified-файле (остальные 132 — тот же подпаттерн в других селекторах):

```text
body{background-color:var(--timeline-background-color,var(--cpd-color-bg-canvas-default));border:0;color:var(--timeline-text-color);
```

Функция в стиле branding.py (вставлять рядом с `rebrand_error_view`, в `apply()`
добавить обход `sorted((app/"bundles").glob("*/theme-*-custom.css"))`):

```python
TIMELINE_TEXT = "var(--timeline-text-color)"
TIMELINE_TEXT_FIXED = "var(--timeline-text-color,var(--cpd-color-text-primary))"

def rebrand_theme_custom(css: str) -> str:
    """Restore body text contrast in Element's custom-theme sheets.

    Upstream theme-{light,dark}-custom.css reference the dead legacy variable
    --timeline-text-color WITHOUT a fallback (133 uses, 0 definitions), so
    `color` becomes invalid-at-computed-value-time and inherits the
    @media (prefers-color-scheme) tokens from <html>: light-on-white text for
    dark-OS visitors. The sibling --timeline-background-color always carries a
    fallback, which is why only the text is broken. See THEMES.md."""
    if TIMELINE_TEXT not in css and TIMELINE_TEXT_FIXED in css:
        return css  # already patched; re-run is a no-op
    out = css.replace(TIMELINE_TEXT, TIMELINE_TEXT_FIXED)
    if TIMELINE_TEXT in out:
        raise BrandingError("custom theme CSS: --timeline-text-color survived")
    if out.count(TIMELINE_TEXT_FIXED) < 133:
        raise BrandingError("custom theme CSS: expected >=133 fallback additions")
    return out
```

Эффект проверен на живом сайте перехватом ответа (route-intercept с той же заменой):
`body color rgb(235,238,242)` → `rgb(27,29,34)` на белом фоне, контраст
1.16:1 → 16.86:1. Поведенчески ничего не меняет — светлая тема остаётся светлой,
просто перестаёт наследовать ОС-токены.

> **Актуальная реализация — `THEME-TOKENS.md`.** Этот набросок (подмена каждого
> `var(--timeline-text-color)` на вариант с fallback) исторический: в коде
> переменная теперь **определяется** блоком `plotina-theme-tokens` в конце
> каждого листа, а не патчится в 133 местах. Причина: та же болезнь была у 40
> других легаси-токенов, и `--timeline-text-color` — лишь самый заметный из 41.
> Тест `element-web/tests/branding_test.py` теперь требует, чтобы лист вообще не
> использовал необъявленный custom property без fallback, поэтому возврат
> per-use подмены его валит.

### Опционально: чтобы «следуй системе» реально давал тёмную тему

Это уже продуктовое решение (апстрим #34948 открыт; в 1.12.32 `themeBasedOnSystem()`
возвращает только `light|dark`, custom-темы не участвует). Три варианта по возрастанию
инвазивности:

1. **config.json** (без правки бандла): завести `setting_defaults.use_system_theme`
   нельзя — явного `theme` из setting_defaults это всё равно не перекроит; но можно
   выдать dark-ОС-посетителю тёмную тему через собственный дефолт, если убрать
   `setting_defaults.theme` и `default_theme` (тогда сработает ветка
   `getValue("use_system_theme")` и посетитель получит встроенную `dark`, не нашу).
2. **JS-патч init.js** (точечный, поддерживает нашу пару Plotina Mint / Plotina Mint
   Dark): в `getEffectiveTheme` перед возвратом явной `custom-`-темы подменять её на
   парную тёмную/custom при `preferDark.matches`. Точная опора (minified, init.js):
   `FIND: const e=o.A.getValueAt(u.p.DEVICE,"theme",null,!1,!0);if(e)return i.vF.log("returning explicit theme: "+e),e;`
   с вставкой вида `if(e&&this.preferDark.matches&&e.startsWith("custom-")&&!((0,c.TP)(e.slice(7)).is_dark)&&customDarkExists)return "custom-Plotina Mint Dark";` —
   требует аккуратной реализации (имена тем захардкожены) и отдельной пробы; в этой
   ветке не применялся.
3. Дождаться апстрим-фикса #34948 (custom themes + system match) и обновить сборку.

## 4. Проба

`probe-theme.spec.ts` (корень worktree): свежий контекст, `colorScheme:"dark"`,
`https://chat.plotina.cc/`, ждёт класс `cpd-theme-*` на body + активацию листа темы,
замеряет luminance/контраст и ассертит: фон тёмный (<0.5) И текст светлый (>0.5) И
контраст ≥ 4.5. **Статус: FAILED (красная), как и задумано** — на ассерте тёмного
фона (received luminance 1, `rgb(255,255,255)`) и контраста (1.16:1); ассерт
«текст светлый» проходит — это и есть вторая половина бага.

Запуск (браузеры Playwright уже установлены в `~/.cache/ms-playwright`, версия
пакета — из `e2e/package-lock.json`):

```bash
cd /home/hermes/wt-t1/e2e && npm ci
cd /home/hermes/wt-t1 && NODE_PATH=$PWD/e2e/node_modules \
  e2e/node_modules/.bin/playwright test probe-theme.spec.ts
# опционально PLOTINA_CHAT_URL=https://staging.chat.plotina.cc/ ...
```

После CSS-патча (раздел 3) проба останется красной по критерию «фон тёмный» — при
зафиксированной в config светлой теме это корректное поведение; зелёной её сделает
только вариант 2 (или config-решение) из раздела «Опционально», поэтому критерий
пробы стоит согласовать с продуктом: «читаемость» (проходит после патча 3) vs
«следование ОС» (нужен патч раздела 3.Опционально).

## 5. Как воспроизвести исследование

```bash
cd scratch && curl -s https://chat.plotina.cc/ -o index.html      # -> bundles/<hash>/bundle.js
curl -s https://chat.plotina.cc/bundles/<hash>/bundle.js -o bundle.js   # загрузчик, карта .u=
curl -s https://chat.plotina.cc/bundles/<hash>/{init,element-web-app,styles}.js -O
curl -s https://chat.plotina.cc/bundles/<hash>/bundle.css -O
# theme-*-custom.css, theme-{light,dark}.css — оттуда же
# затем grep: "--timeline-text-color", "getEffectiveTheme", "prefers-color-scheme"
```

Инструменты прогона: `playwright` 1.56.1 из `e2e/` (chromium-1194), скрипты замера
(`list_chunks/race_probe/color_rule_probe/fix_check`) — временные, в репо не коммитчены.
