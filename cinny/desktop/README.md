# Cinny Desktop for plotina.cc

Наш билд Cinny Desktop (Tauri 2) с шумоподавлением DeepFilterNet3. Это не форк
исходников в смысле долгоживущей ветки: мы берём апстрим на закреплённом теге,
патчим **готовый веб-дист** и собираем установщики своим конфигом. Патч, конфиг и
рецепт лежат здесь, бинарники — в релизах.

## Что внутри

```
config.json          дефолтный homeserver (plotina.cc), без featured-коммьюнити
apply-noise.py       вставляет noise/ и теги в dist/index.html + dist/public/element-call/index.html
tauri.plotina.json   оверрайд сборки: без beforeBuildCommand, updater выключен, цели appimage+deb
noise/               логика и обвязка шумодава (общие с Element Web и Cinny Web)
```

## Локальная сборка

```bash
git clone --recurse-submodules --depth 1 --branch v4.12.8 https://github.com/cinnyapp/cinny-desktop.git
cd cinny-desktop && npm ci
cd cinny && npm ci && npm run build && cd ..
cp ../config.json .
python3 ../apply-noise.py --dist cinny/dist --noise ../noise
npm run tauri -- build --config ../tauri.plotina.json
```

Артефакты: `src-tauri/target/release/bundle/{appimage,deb}/`.

## Почему так, а не «пусть грузит наш сайт»

Tauri умеет открывать внешний URL, но тогда удалённой странице нужен доступ к IPC —
это класс уязвимости CVE-2024-35222. Поэтому веб-часть вкомпилирована в приложение,
а обновления идут только с наших сборок.

## Обновления

`plugins.updater.endpoints` в нашем конфиге пустой, `createUpdaterArtifacts: false`:
билд не предлагает обновиться до апстрима. Когда заведём свой фид, здесь появятся
наш minisign-pubkey и ссылка на `latest.json` в наших релизах.

## Лицензия

Cinny и cinny-desktop — AGPL-3.0. Мы распространяем модифицированные бинарники,
поэтому обязаны предоставить соответствующий исходник: публичный репозиторий с этим
патчем и есть выполнение этого требования. Уведомления об авторских правах апстрима
не удалять.
