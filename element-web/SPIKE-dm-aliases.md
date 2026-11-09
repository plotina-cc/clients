# SPIKE: личные имена комнат (DM → «Денчик» только у меня)

**Статус: рабочий прототип получился.** Имя комнаты хранится в account data
(`cc.plotina.room_aliases`), применяется в списке комнат и в заголовке открытой
комнаты, `m.room.name` при этом не меняется, второй аккаунт ничего не видит.
Проверено на собранном `prepare-webapp.sh` webapp с локальным одноразовым
homeserver-ом: 10/10 автоматических проверок (`spike-dm-aliases/proof.txt`), шесть
скриншотов, ответы API до/после (`spike-dm-aliases/api-state.txt`).

> **Обновление после QA (ветка `wt/dm-aliases-v12`).** Независимый QA нашёл
> критический дефект: прототип проверялся на комнатах v≤11, а в v12 (opaque room
> id без серверной части, дефолт Synapse ≥1.162) валидация id не пропускала
> комнату — фича тихо не работала. Плюс алиас ставился и на группы, а после
> сброса оставался пустой объект. Всё три пункта исправлены, проверка на
> настоящем v12 (Synapse 1.164.1) — 18/18: см. `FIX-dm-aliases-v12.md`.
> Раздел §5 ниже описывает швы исходного спайка и в части id/групп устарел.

Дата: 2026-11-10. Ветка `wt/spike-dm-aliases`. Внешний лимит спайка не менялся
(апстрим не трогали, релизов и деплоев нет).

## TL;DR

- **Маршрут: runtime-overlay**, как `plotina-update-channel.js`. В минифицированный
  dist ничего не вшивается: один JS-файл + один `<script>` в `index.html`.
- Точка подключения найдена и проверена в бандле `v1.12.32`:
  `window.mxMatrixClientPeg` (ставит сам matrix-react-sdk) и
  `Room.prototype.calculateRoomName` (matrix-js-sdk 44 держит имя в **own**
  property `Room.name`, поэтому патчится не геттер, а прототип-метод).
- Патч живёт на уровне модели, а не DOM: `Room.name` читают и список комнат, и
  заголовок, и `document.title`, и тосты/уведомления — поэтому переопределение
  одно, без гонок с React-рендером и без MutationObserver на текст.
- Account data пишется через `client.setAccountData`, читается на старте и на
  событии `accountData`; перерисовка — `room.recalculate()` (он же эмитит
  `Room.name`).
- Минимальный UI: карандаш в заголовке комнаты → диалог «Личное имя» с
  «Сохранить» / «Сбросить» / «Отмена».
- Сборку element-web из исходников **не делали** и она не нужна.

## 1. Что было нужно

Переименовать диалог «Даниил» → «Денчик» **только для себя**: сейчас имя лежит в
состоянии комнаты (`m.room.name`), поэтому его видит собеседник.

Требования прототипа: account data `cc.plotina.room_aliases` формата
`{"<room_id>": "<имя>"}`; имя из алиаса в списке и в заголовке; минимальный UI
установки/снятия; доказательство, что `m.room.name` не меняется; негативный
контроль вторым аккаунтом.

## 2. Как мы правим element-web: разбор маршрутов

Факты, на которых строился выбор (команды и вывод — `spike-dm-aliases/bundle-hooks.txt`):

1. `element-desktop/scripts/prepare-webapp.sh` тянет **готовый релизный тарбол**
   `element-v1.12.32.tar.gz` (sha256 `27599ca285d8…` сверяется с
   `webapp.lock.json`), распаковывает 170 МБ dist и правит его оверлеями.
   Сборки из исходников нет и в спайке не появлялось.
2. Дистрибутив приходит с **source map-ами и `sourcesContent`**: можно читать
   исходники модулей, не собирая их (это и использовано для анализа).
3. В `bundles/7fef2be0ae8530458db3/init.js` есть
   `window.mxMatrixClientPeg||(window.mxMatrixClientPeg=T)` — страница сама
   публикует `MatrixClientPeg`. Это ровно тот хук, через который можно добраться
   до живого `MatrixClient` и его комнат.
4. `matrix-js-sdk@44.0.0` (`src/models/room.ts` из source map):
   - `387: public name: string;` — имя это **поле**, не геттер;
   - `3367: public recalculate(): void` — пересчитывает имя и summary,
     `3397: this.name = this.calculateRoomName(this.myUserId)`,
     `3404: this.emit(RoomEvent.Name, this)`;
   - `3660: private calculateRoomName(userId, ignoreRoomNameEvent = false)` —
     именно она возвращает `m.room.name`, иначе canonical alias, иначе heroes.

### Вариант A — runtime overlay (выбран)

Почему сработало: `Room.name` — обычное поле, которое пересчитывается
`recalculate()`. Достаточно (а) один раз обернуть прототип-метод
`calculateRoomName`, (б) хранить карту алиасов, (в) после изменения карты
позвать `room.recalculate()` — он эмитит `Room.name`, и все подписчики
(matrix-react-sdk перерисовывает список, заголовок, title) читают уже новое имя.

Плюсы: нет патча минифицированных литералов, нет DOM-переписывания, нет гонок
(значение живёт в модели, сколько бы раз React ни рендерил), один файл на оба
клиента, откат — удалить `<script>`. Минусы: держится на имени приватного
метода в matrix-js-sdk — при мажорном апгрейде апстрима это надо перепроверять
(в скрипте есть проверки на месте: `typeof proto.calculateRoomName === "function"`,
иначе патч молча не включается и приложение работает как раньше).

### Вариант B — пост-обработка dist (не понадобился)

`branding.py`-стиль (замена литералов в `bundles/*.js` с count-проверкой) здесь
дал бы хрупкий патч: имя собирается в приватном методе, а не строковым
литералом; пришлось бы вшивать код в минифицированный чанк `2847.js` (2.5 МБ) и
ловить регэкспом тело функции. Дороже и ломче, чем вариант A, при том же
результате. Оставлен как запасной путь, если апстрим переименует
`calculateRoomName` и обёртка перестанет ставиться.

### Вариант C — сборка element-web из исходников

Не делали: это переделка CI и потеря «пин на релизный тарбол». По факту не
нужна — вариант A покрывает всю задачу.

## 3. Что сделано

Новый файл `element-web/plotina-dm-aliases.js` (общий для Web и Desktop):

- account data `cc.plotina.room_aliases` — `setAccountData` при сохранении,
  чтение `getAccountData` на старте и по событию `accountData`;
- обёртка `calculateRoomName` (один раз на прототип, флаг `__plotinaRoomAliases`);
  `ignoreRoomNameEvent=true` (это `getDefaultRoomName()`) **не** подменяется —
  «имя по умолчанию» остаётся настоящим;
- после изменения карты — `recalculate()` всех комнат;
- ждёт появления `window.mxMatrixClientPeg` (poll 250 мс) — гонки с загрузкой
  бандла нет;
- UI: кнопка-карандаш в `.mx_RoomHeader_info` (пере-вставляется MutationObserver-ом
  после пере-рендеров), диалог со строками ru/en, «Сохранить» / «Сбросить»;
- тестовый хэндл `window.plotinaDmAliases` (`aliases()`, `setAlias`,
  `clearAlias`, `ready()`) — им же пользуется `proof.mjs`.

Встраивание (по правилу паритета Web ↔ Desktop, всё через
`element-web/webapp_fixes.py`):

| Файл | Что |
| :-- | :-- |
| `element-web/webapp_fixes.py` | `DM_ALIASES_FILE`, `dm_aliases_tag`, `inject_dm_aliases_tag` (idempotent, ровно один тег перед `</head>`), `ensure_dm_aliases` |
| `element-web/branding.py` | вызов инжекта + проверка «тег ровно один» + запрет относительного src на вебе |
| `element-web/Dockerfile` | `COPY plotina-dm-aliases.js /app/` + проверки `test -s` и `count == 1` |
| `element-desktop/branding.py` | копирует payload из `../element-web` в webapp и вызывает `ensure_dm_aliases(relative=True)` |
| `element-desktop/scripts/prepare-webapp.sh` | `cmp` payload с исходником, `count == 1`, запрет root-absolute src |
| `element-web/tests/branding_test.py` | `DmAliasesTest`: тег, идемпотентность, падение без payload, COPY в Dockerfile, «оверлей не пишет состояние» |
| `element-web/tests/dm_aliases.test.js` | node-тесты чистых функций: разбор account data (только строки, trim, только `room_id`) и иммутабельное обновление карты — 9 проверок |
| `element-desktop/tests/test_webapp_fixes.py` | паритет: одинаковые байты в обоих деревьях, разные только формы src, стабильность при повторном прогоне |

Проверки-счётчики в стиле репозитория: и в Docker-образе, и в
`prepare-webapp.sh` сборка падает, если тег не найден или найден не один раз.

## 4. Доказательство

Окружение: одноразовый homeserver **continuwuity 0.5.3** на `127.0.0.1:8008`
(не golova, не plotina.cc, продакшн не тронут), два аккаунта `alice`/`bob`,
настоящий DM (`is_direct`, invite+join), у `bob` displayname «Даниил».
Webapp — **собранный** `element-desktop/scripts/prepare-webapp.sh` (218 МБ,
`webapp ready`, все проверки скрипта прошли, `spike-dm-aliases/build.txt`),
раздан локально на `127.0.0.1:8092`.

Ветка Element Web тоже проверена сборкой: Docker-образ собрался с новым
`COPY` и Dockerfile-проверками (`test -s` + `count == 1`), а из готового
`/app` вынуто и сверено — ровно один `<script src="/plotina-dm-aliases.js"
defer>` (относительного нет), payload побайтово равен
`element-web/plotina-dm-aliases.js` (17527 байт) — `spike-dm-aliases/web-image-check.txt`.

Прогон: `element-web/spike-dm-aliases/proof.mjs` (Playwright, три браузерных
контекста, полный вывод — `spike-dm-aliases/proof.txt`):

```
PASS stock name before rename: header="Даниил" room.name="Даниил" aliases={}
PASS header takes the alias: header="Денчик"
PASS room list takes the alias: list=["Денчик","spike.local Admin Room"]
PASS Room.name takes the alias: room.name="Денчик"
PASS advertised alias map: {"!i2kHEuNKioA9a0Xrkn:spike.local":"Денчик"}
PASS m.room.name still absent: HTTP 404 M_NOT_FOUND: State event not found
PASS alias lives in account data: {"!i2kHEuNKioA9a0Xrkn:spike.local":"Денчик"}
PASS second account does not see the alias: header="alice 🏳️‍⚧️" aliases={}
PASS alias is per account, both directions: other header="Алиса-для-Боба"
     other account_data={"!i2k…":"Алиса-для-Боба"} owner room.name="Денчик"
PASS alias applied at startup without action: aliases={…"Денчик"} header="Денчик"

10/10 checks passed
```

Скриншоты (`spike-dm-aliases/`):

| Файл | Что видно |
| :-- | :-- |
| `01-before-alias.png` | DM с именем «Даниил» (как до переименования) |
| `02-dialog.png` | диалог «Личное имя» с подсказкой «Видно только вам…» |
| `03-after-alias.png` | «Денчик» в заголовке и в списке комнат |
| `04-second-account.png` | второй аккаунт в том же room: имя не изменилось |
| `05-restart-fresh-device.png` | новое устройство: алиас применился без действий |
| `06-second-account-own-alias.png` | второй аккаунт переименовал комнату **у себя** («Алиса-для-Боба»); у владельца осталось «Денчик» |

Состояние комнаты до/после (`spike-dm-aliases/api-state.txt`, оба аккаунта,
метки `before-evidence` / `after-rename` / `after-both-aliases` — последняя уже
после того, как второй аккаунт поставил свой собственный алиас):

```
account_data cc.plotina.room_aliases  alice: 200 {"!i2k…":"Денчик"}   bob: 404 M_NOT_FOUND
state m.room.name                     alice: 404 M_NOT_FOUND          bob: 404 M_NOT_FOUND
state name/alias events               []                              []
state members                         Даниил / alice 🏳️‍⚧️            Даниил / alice 🏳️‍⚧️
```

(в метке `after-both-aliases` у bob-а в account data свой
`{"!i2k…":"Алиса-для-Боба"}`, а `m.room.name` по-прежнему 404 у обоих)

То есть `m.room.name` не появлялся вообще (комната и до спайка жила без него —
имя было производным от displayname), а «Денчик» существует только в account
data аккаунта `alice`: у `bob` в собственной карте про него ничего нет.

Дополнительно проверено:

- клиент сохраняет карту **до** перерисовки (оптимистично) и перечитывает её по
  `accountData`; двойного применения нет — `apply()` идемпотентен;
- «Сбросить» возвращает «Даниил» в заголовке и в списке, account data
  очищается (`aliases={}`);
- имя из алиаса переживает **новый девайс** (свежий браузерный контекст) — это
  и есть «чтение при старте»: до любого клика `aliases` уже заполнены.

## 5. Что не покрыто и где честные швы

1. **Заголовок вкладки (`document.title`) отстаёт.** Измерено в прогоне:
   `INFO tab title: after rename="… | Даниил" after 8s="… | Даниил"
   after a room switch="… | Денчик"`. Matrix-react-sdk обновляет title на
   смене комнаты, а не на `Room.name`. Заголовок комнаты (то, что требовалось)
   обновляется сразу; title — при следующем переключении. Лечится отдельным
   хуком на `RoomEvent.Name` + пересчётом title (нужно смотреть внутренний
   PageTitleUpdater в matrix-react-sdk).
2. **Форма «Название комнаты» в настройках комнаты** читает состояние, а не
   `Room.name` (`RoomProfileSettings.tsx` из source map: `nameEvent =
   room.currentState.getStateEvents(EventType.RoomName, "")`). Это хорошо:
   алиас туда не попадает и «Сохранить» не может случайно записать алиас в
   состояние комнаты. Но и увидеть алиас в настройках нельзя — отдельная точка
   для UI прод-этапа.
3. **Пуш-уведомления и e-mail от сервера** не знают про алиас: текст собирает
   homeserver из `m.room.name`/displayname. В браузерные тосты/`Notifier.ts`
   имя попадает через `room.name`, то есть там алиас подхватится, но
   серверные пуши — нет (и это принципиально: алиас локален по определению).
4. **Экспорт комнаты** (`utils/exportUtils/*`) возьмёт алиас — это скорее
   плюс, но стоит решить осознанно.
5. **Room upgrade** (`m.room.tombstone` → новый `room_id`): карта привязана к
   `room_id`, при апгрейде алиас надо переносить. В спайке не делали.
6. **Другие клиенты** (Cinny, FluffyChat, Element X) не тронуты — по условиям
   задачи.
7. **Tab title/уведомления/поиск в целом** — см. п. 1 и 3: не проверял
   прицельно, кроме title (измерен) и `Notifier.ts` (читает `room.name`).

## 6. До прода: точки и оценка

| Работа | Дни |
| :-- | :-- |
| Пункт меню «Переименовать для себя» в контекстном меню комнаты + «Сбросить» в настройках комнаты (сейчас карандаш в заголовке — минимальный UI спайка) | 1 |
| Обновление `document.title` по `RoomEvent.Name` (или пере-использовать внутренний PageTitleUpdater) | 0.5 |
| Перенос алиаса при room upgrade (подписка на `Room.tombstone`/замену комнаты) | 0.5 |
| Юнит-тесты оверлея (node + фейковый `MatrixClient`/Room: карта, `ignoreRoomNameEvent`, идемпотентность) и e2e в CI по образцу `e2e/` | 1 |
| Проверка и доводка уведомлений/поиска/тостов, i18n строк в наши `ru`-переопределения | 1 |
| Документация (README + этот файл → `THEMES.md`-стиль), QA-прогон, скриншоты для релиза | 0.5 |

Итого ~4.5 дня на Element Web + Desktop (один и тот же payload, паритет уже
обеспечен тестами). Отдельно: Cinny/Element X/FluffyChat — по своей задаче на
клиент, логика та же (account data + переопределение имени в модели).

## 7. Как воспроизвести

```bash
# 1. локальный одноразовый homeserver (не прод): continuwuity 0.5.3
./conduwuit -c conduwuit.toml           # allow_registration + registration_token
python3 provision.py                    # alice/bob, DM, displayname «Даниил»

# 2. собранный webapp (нужен SENTRY_DSN: в репозитории ключ замаскирован)
SENTRY_DSN='https://0123456789abcdef0123456789abcdef@sentry.plotina.cc/relay/1' \
  element-desktop/scripts/prepare-webapp.sh
# в .build/webapp/config.json подставить локальный homeserver (только для прогона)
(cd element-desktop/.build/webapp && python3 -m http.server 8092 --bind 127.0.0.1 &)

# 3. доказательство (Playwright есть в e2e/ этого же репозитория)
PLAYWRIGHT_MODULE=file://$PWD/../e2e/node_modules/playwright/index.mjs \
  node element-web/spike-dm-aliases/proof.mjs \
    --base http://127.0.0.1:8092 --homeserver http://127.0.0.1:8008 \
    --owner alice:alice-spike-pass --other bob:bob-spike-pass \
    --room '!i2kHEuNKioA9a0Xrkn:spike.local' \
    --out element-web/spike-dm-aliases
```

`spike-dm-aliases/bundle-hooks.sh <webapp>` заново печатает доказательства по
бандлу (хук `window.mxMatrixClientPeg` и факты из `room.ts`), если понадобится
перепроверить точку подключения на новом апстриме. `spike-dm-aliases/build-evidence.sh`
пере-собирает `build.txt` из свежего прогона `prepare-webapp.sh`.

## 8. Что не вышло / отдельные заметки

- **Не** стал патчить `document.title` вручную «на скорую руку» (замена
  подстроки в title): это ломается на счётчиках непрочитанных и на локали.
  Оставил как работу прод-этапа с честным измерением (см. §5.1).
- `conduwuit` не поддерживает `DELETE` для account data (`M_UNRECOGNIZED`),
  сброс в прогоне сделан `PUT {}` — на Element это не влияет (оверлей пишет
  полную карту), но в скриптах пришлось учесть.
- В репозитории уже **падал до спайка** тест
  `element-web/tests/branding_test.py::NodeThemeLogicTest::test_theme_init_logic`
  (`custom-Plotina Mint not in custom-Mint Light,custom-Mint Dark` —
  `config.json` и `plotina-theme.js` расходятся в именах тем). Проверено на
  `HEAD` (`7b68a1b`) в отдельном worktree: падает так же, к этому спайку
  отношения не имеет и не трогался.
- `scripts/preflight.sh` гоняет `element-web` с шаблоном `test_*.py`, поэтому
  `branding_test.py` в него не попадает (preflight при этом зелёный:
  `preflight: ok`). Это существующая особенность, не менял; свои тесты гонял
  явно: `python3 -m unittest discover -s element-web/tests -p '*_test.py'`
  → 52 теста, единственное падение — то самое пре-существующее.
  `element-desktop`: 128 тестов, `OK`. `element-web/tests/run.sh` (60 тестов)
  красный ровно из-за него же — на `HEAD` тоже.
- Скриншоты из ad-hoc браузерного харнесса периодически отдавали устаревший
  кадр (общий `/tmp/shot.png` на несколько сессий) — поэтому доказательный
  прогон сделан Playwright-скриптом, который сам пишет файлы.
- Локальная сборка Docker-образа Element Web требует gitignored-ассетов
  `noise/dfn/` (~24 МБ): в чистом worktree их нет, `Dockerfile` падает на
  `COPY noise/dfn/`. Это существующее свойство репозитория (CI их подкладывает
  так же, как `scripts/build-image.sh` копирует `../noise` в контекст);
  для спайка ассеты взяты из основного чекаута, в git ничего не добавлено.

## 9. Соблюдение запретов

- Релизов, тегов, GitHub-релизов, записей в `/srv/dl`, apt, `/join` — нет.
- Element Web на golova не перезапускался, образ не подменялся; прод-аккаунты
  не использовались (всё на локальном одноразовом сервере).
- `UPSTREAM_TAG` / `webapp.lock.json` не менялись (v1.12.32 как был).
- Синхронизация и серверные части не трогались: только account data через
  публичный клиентский API.