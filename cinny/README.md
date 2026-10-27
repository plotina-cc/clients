# Cinny для plotina.cc

Один каталог на клиент, потому что модификация одна и та же: и веб-версия, и
десктоп получают общий код шумодава из `../noise/` (`logic.js`, `boot.js`,
`cinny-ui.js`, `vendor/` с DeepFilterNet3). Различается только доставка — веб
раздаётся статикой, десктоп вкомпилирует дистрибутив в бинарник Tauri.

Форк исходников здесь не нужен: Cinny берётся на закреплённом теге, патчится
**готовый веб-дист**, установщики собираются нашим конфигом.

## Что внутри

```
config.json          дефолтный homeserver (plotina.cc), без featured-коммьюнити
UPSTREAM_TAG         тег cinny-desktop, на котором собираем
apply-noise.py       копирует noise/ в dist и вставляет теги в два документа
tauri.plotina.json   оверрайд сборки: без beforeBuildCommand, updater выключен
noise.lock.json      URL и sha256 двух бинарников модели (wasm и .tar.gz)
scripts/build.sh     локальная сборка Linux (AppImage + deb)
scripts/fetch-noise.py  докачивает модель в noise/, сверяя sha256
windows/             свой NSIS-установщик: installer.nsi + build-installer.sh
```

## Cinny Web

Статика на edge (`/srv/cinny`), сборки нет.

1. Скопировать `../noise/` в `/srv/cinny/noise`, чтобы `/noise/logic.js`
   резолвился в том же origin.
2. Вставить теги в два документа:
   - `index.html` — оболочка приложения, получает
     `<script src="/noise/logic.js"></script><script src="/noise/cinny-ui.js" defer></script>`
     (это рисует ползунок в Настройки → General);
   - `public/element-call/index.html` — встроенная страница Element Call,
     единственная, кто реально вызывает `getUserMedia`, получает
     `<script src="/noise/logic.js"></script><script src="/noise/boot.js" defer></script>`.
3. Кэширование на edge: `/noise/dfn/*` — 30 дней, `/noise/*.js` — `no-cache`,
   чтобы фикс доезжал без жёсткой перезагрузки.

Правки идемпотентные: перед вставкой проверяется маркер, рядом с каждым
изменённым документом остаётся `.bak-plotina`.

**Почему два документа.** Cinny показывает звонок в iframe на
`public/element-call/index.html`; у iframe свой `window`, поэтому обёртка
`getUserMedia` в родительской странице звонок не увидит. Родителю нужен только UI
настроек.

Проверка: `https://cinny.plotina.cc/noise/logic.js` отдаёт 200; в Настройки →
General сверху виден ползунок «Подавление шума» со значением 60
(`localStorage: plotina.noise.level`); в звонке внутри iframe
`window.__plotinaNoise.isSupported()` возвращает `true`, а
`window.__plotinaNoiseStats` считает `callRequests`, `otherAudioRequests`,
`processed`, `failed` — по нему видно, если апстрим сменил форму constraints.

## Cinny Desktop

```bash
git clone --recurse-submodules --depth 1 --branch "$(cat UPSTREAM_TAG)" \
  https://github.com/cinnyapp/cinny-desktop.git upstream
cd upstream && npm ci
cd cinny && npm ci && npm run build && cd ..

mkdir -p noise/vendor
cp ../noise/logic.js ../noise/boot.js ../noise/cinny-ui.js noise/
cp -a ../noise/vendor/. noise/vendor/
python3 scripts/fetch-noise.py
cp config.json upstream/config.json
python3 apply-noise.py --dist upstream/cinny/dist --noise noise
npm run tauri -- build --config "$PWD/tauri.plotina.json"
```

Артефакты: `upstream/src-tauri/target/release/bundle/{appimage,deb}/`.
Windows — кросс-сборкой (`cargo-xwin`, `--no-bundle`) плюс `windows/installer.nsi`
через `makensis`; подробности в комментариях внутри этих файлов. CI делает то же
самое нативно на windows-latest.

**Почему не «пусть грузит наш сайт».** Tauri умеет открывать внешний URL, но
тогда удалённой странице нужен доступ к IPC — это класс уязвимости
CVE-2024-35222. Поэтому веб-часть вкомпилирована, а обновления идут только с
наших сборок.

## Обновления

`plugins.updater.endpoints` пустой, `createUpdaterArtifacts: false`: билд не
предлагает обновиться до апстрима. Когда заведём свой фид, здесь появятся наш
minisign-pubkey и ссылка на `latest.json` в релизах.

Тег `v*-plotina.*` в этом репозитории запускает сборку Linux/Windows/macOS и
создаёт релиз с артефактами.

## Лицензия

Cinny и cinny-desktop — AGPL-3.0. Мы распространяем модифицированные бинарники и
отдаём веб-версию по сети, поэтому обязаны предоставить соответствующий исходник:
этот публичный репозиторий и есть выполнение требования. Уведомления об авторских
правах апстрима не удалять.
