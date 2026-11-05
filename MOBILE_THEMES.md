# Мобильные клиенты Plotina: поведение темы

Аудит по состоянию на 2026-11-05. Источники: upstream-теги из `pins.env` /
`UPSTREAM_TAG` плюс слой патчей `element-x/patches/`, `fluffychat/patches/`.
Ни один plotina-патч не затрагивает файлы темы — поведение целиком определяется
upstream.

## Итоговая таблица

| Клиент | Upstream / тег | Следует системе по умолчанию? | Дефолт при отсутствии настройки | Переключатель темы | Где менять (файл : строка) |
|---|---|---|---|---|---|
| **element-x** | element-x-android `v26.10.1` | **Да** | `Theme.System` | Да: Настройки → «Внешний вид» (System / Light / Dark; Black за feature-flag) | дефолт: `libraries/compound/.../theme/Theme.kt:57`; initial: `libraries/designsystem/.../theme/ElementThemeApp.kt:69` |
| **fluffychat** | fluffychat `v2.11.3` | **Да** | `ThemeMode.system` | Да: Настройки → «Стиль», сегменты Light / Dark / System | дефолт: `lib/widgets/theme_builder.dart:40` |

## Element X (element-x-android v26.10.1)

- enum тем: `libraries/compound/src/main/kotlin/io/element/android/compound/theme/Theme.kt:19-24` —
  `System, Dark, Black, Light`.
- Дефолт «система»: ключ `theme` (`libraries/preferences/impl/src/main/kotlin/io/element/android/libraries/preferences/impl/store/DefaultAppPreferencesStore.kt:34`,
  DataStore `elementx_preferences`) при первом запуске отсутствует,
  `mapToTheme` трактует `null → Theme.System` (`Theme.kt:57`).
  Компоновщик тоже стартует с `Theme.System`
  (`ElementThemeApp.kt:69`, `PreferencesRootPresenter.kt:96`).
- Реализация follow-system: `ElementThemeApp.kt:71-77` вызывает
  `AppCompatDelegate.setDefaultNightMode(MODE_NIGHT_FOLLOW_SYSTEM)`;
  признаок темноты читается из конфигурации application-контекста
  (`Theme.kt:44-52`, обход `isSystemInDarkTheme` из-за перезаписи
  конфигурации AppCompat'ом — там же комментарий).
- Переключатель: экран настроек, дропдаун «Внешний вид» —
  `features/preferences/impl/src/main/kotlin/io/element/android/features/preferences/impl/root/PreferencesRootView.kt:324-334`
  (иконка DarkMode), запись — `PreferencesRootPresenter.kt:150-153` →
  `AppPreferencesStore.setTheme`. Вариант Black доступен только при
  `FeatureFlags.AllowBlackTheme` (`PreferencesRootPresenter.kt:123-127`).
- Что менять, чтобы дефолт стал «следовать системе»: **ничего — уже следует**.
  Если понадобится наоборот захардкодать фиксированную тему:
  1) `Theme.kt:57` (`null -> Theme.System`) и 2) `ElementThemeApp.kt:69` +
  `PreferencesRootPresenter.kt:96` (`initial = Theme.System`) — заменить на
  нужную; либо патчем добавить `setTheme(...)` при первом запуске.

## FluffyChat (v2.11.3)

- Дефолт «система»: `lib/widgets/theme_builder.dart:40` —
  `ThemeMode get themeMode => _themeMode ?? ThemeMode.system;`.
  Ключ `theme_mode` в SharedPreferences (`theme_builder.dart:26`); если
  значения нет или оно не распознано (`theme_builder.dart:51-58`), `_themeMode`
  остаётся `null` → системный режим.
- Проброс в UI: `lib/widgets/fluffy_chat_app.dart:88-91` —
  `ThemeBuilder` → `MaterialApp.router(themeMode: …, theme: light,
  darkTheme: dark)`.
- Переключатель: Настройки → Стиль —
  `lib/pages/settings_style/settings_style_view.dart:49-70`
  (`SegmentedButton<ThemeMode>`: Light / Dark / System), логика
  `settings_style.dart:115-128` → `ThemeController.setThemeMode`
  (сохраняет имя режима в тот же ключ `theme_mode`).
- Что менять, чтобы дефолт стал «следовать системе»: **ничего — уже следует**.
  Для принудительной фиксированной темы править fallback в
  `theme_builder.dart:40` (плюс запись начального значения в `_loadData`).
- Патчи Plotina (`0001`–`0011`) трогают `lib/main.dart`, настройки чата/шума,
  push, Sentry, id/название — файлы темы не изменяют.

## Оговорки

- «Дефолт» действует только при чистой установке / пустном хранилище:
  выбор пользователя сохраняется (Element X — DataStore `theme`,
  FluffyChat — SharedPreferences `theme_mode`) и имеет приоритет над
  системной темой.
- Локализованные подписи опций приходят из строк upstream
  (Element X — Localazy `theme_*`, FluffyChat — `systemTheme` и т.п.);
  патчи visible-strings их не переопределяют.
