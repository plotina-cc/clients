# THEME-FIX: модалка верификации устройства (Plotina Web / Element v1.12.32)

Ветка: `theme/modal-a11y`. Продакшн: `https://chat.plotina.cc` (бандл
`81bff4fd060173d686ec`, элементная база — `vectorim/element-web:v1.12.32`).
Логин в боевой аккаунт не выполнялся: всё ниже получено разбором бандлов +
DOM-пробой реальной страницы (`element-web/tests/modal_a11y_probe.py`).

## 1. Компонент и классы

Модалка «Подтвердите свою цифровую личность» (`_t("encryption|verification|confirm_identity_title")`):

- `element-web/src/components/structures/auth/CompleteSecurity.tsx` (класс
  `eI` в `element-web-app.js`) — рендерит `<AuthPage addBlur={false}>` →
  `<Glass className="mx_Dialog_border">` → `CompleteSecurityBody` →
  `SetupEncryptionBody`.
- `element-web/src/components/structures/auth/SetupEncryptionBody.tsx` (фаза
  `Phase.Intro`) — карточка `EncryptionCard` c классом
  `mx_EncryptionCard_noBorder mx_SetupEncryptionBody` и четырьмя кнопками:
  «Используйте другое устройство», «Используйте recovery key», «Не можете
  подтвердить?» и, при `allowLogout` (в `CompleteSecurity` он `true`),
  **Sign out** = `_t("action|sign_out_before_verify")`.

DOM-цепочка: `#matrixchat > .mx_AuthPage > .mx_AuthPage_modal >
main.mx_AuthPage_modalContent > div.mx_Dialog_border (compound Glass,
`._glass_sepwu_8`) > .mx_CompleteSecurityBody > … > .mx_EncryptionCard_buttons`.

## 2. Причина обрезки (проблема 1)

CSS из `bundles/81bff4fd060173d686ec/theme-light.css` /
`theme-light-custom.css` (оба содержат одинаковые layout-правила):

```css
.mx_AuthPage            { height:100vh; overflow:auto; display:flex; flex-direction:column }
.mx_AuthPage_modal      { display:flex; margin:100px auto auto }   /* ≤768px: margin-top:50px */
.mx_Dialog_border       { max-height:calc(100% - var(--cpd-space-6x));
                          flex-direction:column; position:relative }
.mx_CompleteSecurityBody{ padding:20px 20px 60px }                  /* без overflow */
```

`max-height:calc(100% - 24px)` задуман для обычных модалок внутри
`position:fixed`-обёртки `.mx_Dialog_wrapper` ( definite высота = viewport).
Но `CompleteSecurity` использует Glass **внутри AuthPage**, у цепочки
контейнеров которого высота никогда не бывает definite: проценты резолвятся
по content-height родителя, Glass ограничивается `содержимое − 24px`, а
`overflow` у рамки и карточки — `visible`. Итог: нижние ~24px карточки
(при реальной высоте контента — ниже кнопки Sign out) визуально отрезаются,
при этом ничего не скроллится: `mx_AuthPage.scrollHeight == clientHeight`
(страница не считает переполнение прокручиваемым).

Пробa на живом `chat.plotina.cc` (injект точной DOM-цепочки, реальные CSS
бандла, ширина 1366):

```
BASE h=768/620/560: glass clientH=417 scrollH=441 overflowY=visible
                    authPage scrolls=false  → 24px контента отрезаны, скролла нет
```

На ноутбуке пользователя (~1366x768 минус высота браузера) реальная высота
карточки (иконки, переносы русских строк) больше тестовой — отрезается строка
кнопок / «Sign out».

## 3. Патч CSS (внедрён в branding.py)

Блок вставляется в `index.html` перед noise-тегами (после `bundle.css`/theme
ссылкой → выигрывает каскад при равной специфичности), id для идемпотентности:
`plotina-modal-a11y`.

```css
.mx_AuthPage_modalContent>.mx_Dialog_border{max-height:calc(100vh - 150px)}
.mx_CompleteSecurityBody{overflow-y:auto}
```

- проценты → `100vh` (viewport-relative, definite всегда);
- внутренняя прокрутка карточки вместо отрезания;
- селектор сужен `.mx_AuthPage_modalContent>`, обычные диалоги
  (`mx_Dialog_wrapper`) не затронуты;
- `-150px` = margin-top 50/100 + 2×padding Glass (12) + footer AuthFooter ~60.
- **маргины `.mx_AuthPage_modal` не трогать.** Стоковый `margin:100px auto auto`
  держит нижний `auto`, который прижимает `.mx_AuthFooter` (тёмный градиент под
  ссылками) к нижней кромке окна. Любой явный `margin-bottom` (было `50px`)
  приклеивает этот градиент к низу карточки — на 1920×1012 футер висел на
  `y=426…489` вместо `950…1012`. Регресс закреплён в
  `tests/branding_test.py::test_modal_a11y_style`.

После патча (та же проба):

```
FIX h=768/620: glass clientH=441=scrollH  → карточка целиком видна
FIX h=560/500: clientH=410/350 < scrollH=441, overflowY=auto → скролл внутри
```

Точка вставки кода: `element-web/branding.py`, константы `MODAL_CSS` /
`MODAL_BLOCK`, вставка в `rebrand_index()`; проверка сборки —
`grep -q 'plotina-modal-a11y' /app/index.html` в Dockerfile. Повторный запуск
идемпотентен (regex снимает старый блок).

## 4. Непереведённые ru-строки (проблема 2)

Механизм локалей: `i18n/languages.json` → `"ru": "ru.a625131.json"`,
файл отдаётся с `Cache-Control: no-cache` + ETag — можно патчить контент под
тем же именем.

Отсутствия в текущем ru-файле (проверено сравнением `en_EN.9281ded.json` и
`ru.a625131.json`):

| ключ | EN | в ru |
|---|---|---|
| `action.sign_out_before_verify` | Sign out | **нет** → кнопка по-английски |
| `encryption.verification.no_other_devices` | This option is not available because you do not have any other devices | **нет** (tooltip) |
| `encryption.verification.no_recovery_key` | This option is not available because you have not set up a recovery key | **нет** (tooltip) |

«Use recovery key» в ru есть (`use_recovery_key` = «Используйте recovery
key») — если пользователь видит английскую надпись, это та же модалка при
локали en; правки не требует.

Внедрение: `branding.py`, `LOCALE_OVERRIDES` + `rebrand_locales(app/"i18n")`:
рекурсивно добавляет листья **только когда ключа нет** (`_add_missing`) —
когда апстрим переведёт сам, our pass станет no-op; перезапись не ломает
существовавшие переводы, en-файл не трогается; при отсутствии `i18n/` или
ru-файла сборка падает громко (в стиле модуля).

## 5. Probe-скрипт

`element-web/tests/modal_a11y_probe.py` — запускается внутри browser-harness
(`python3 modal_a11y_probe.py [--url URL] [--heights ...]`): открывает
`chat.plotina.cc`, ждёт стабилизации лэйаута (шрифты/custom-тема грузятся
поздно), инжектит точную цепочку Intro-фазы в `<body>` (в `#matrixchat` React
и noise-оверлей чистят чужие узлы), меряет BASE, применяет `MODAL_CSS`
(импортируется прямо из `branding.py` — расхождений не будет), меряет FIX,
убирает за собой. Логина нет, данные не отправляются.

## 6. Статус

- `python3 -m unittest discover -s tests -p '*_test.py'` (element-web): 29/29 OK,
  включая `LocaleTest` (6), `test_modal_a11y_style`, идемпотентность.
- Dockerfile: добавлены `grep -q 'plotina-modal-a11y' /app/index.html` и
  `grep -q 'sign_out_before_verify' /app/i18n/ru.*.json`.
- Патч CSS проверен пробой на реальном бандле (см. таблицы выше).
- Релиз: пересобрать image (`scripts/build-image.sh`), деплой как обычно.
