# OMNIDESK — нативная оболочка (Capacitor)

Нативное приложение под iOS/Android — **тонкая оболочка** (remote-URL), которая
открывает боевую панель по HTTPS в WebView и добавляет то, чего не умеет PWA:
**настоящий push на iPhone** (APNs) и FCM на Android.

Веб-приложение при этом не меняется: оболочка грузит ваш прод как first-party,
поэтому сессия, server actions и SSE работают как в браузере. Нативные пакеты
Capacitor живут ТОЛЬКО в этой папке (`native/`) и не попадают в зависимости и
деплой самой панели.

Собрать бинарники в v0 нельзя — нужен macOS + Xcode (iOS) и Android Studio
(Android). Ниже — что уже сделано в коде и что осталось сделать вам.

## Что уже готово в репозитории

- `scripts/157_device_push_tokens.sql` — таблица токенов устройств.
- `lib/native-push.ts` — отправка APNs (ES256-JWT + HTTP/2) и FCM v1 (OAuth),
  без новых зависимостей; прунинг мёртвых токенов; no-op без ключей.
- `lib/push-dispatcher.ts` — на каждое входящее сообщение шлёт push и в Web
  Push, и нативно (тот же адресат и payload).
- `app/api/native-push/{register,unregister}` — регистрация/удаление токена под
  сессией оператора.
- `lib/capacitor-push.ts` — клиентский мост (через глобал `window.Capacitor`,
  без npm-импортов), смонтирован в `NotificationProvider`; отписка при логауте.
- `native/` — конфиг оболочки, изолированный `package.json`, офлайн-фолбэк.

## Шаг 1. Переменные окружения на сервере (VPS)

Push включается ТОЛЬКО когда заданы ключи — иначе весь нативный путь тихо
выключен (панель работает как раньше).

**iOS / APNs** (Apple Developer → Keys → создать ключ с Apple Push Notifications):

```
APNS_KEY_P8="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
APNS_KEY_ID=ABCD123456          # 10 символов, Key ID
APNS_TEAM_ID=TEAM123456         # 10 символов, Apple Team ID
APNS_BUNDLE_ID=app.omnidesk.mobile   # = CAP_APP_ID
APNS_PRODUCTION=true            # true для App Store/TestFlight, иначе sandbox
```

**Android / FCM** (Firebase Console → Project settings → Service accounts →
Generate new private key):

```
FCM_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...", ...}
```

(весь JSON одной строкой; переводы строк в `private_key` оставьте как `\n`).

После добавления ключей перезапустите панель (`pm2 reload`) — в логе появится
`[push] Dispatcher started (web: true, native: true)`.

## Шаг 2. Миграция БД

Применяется автоматически вашим `deploy.sh` (миграции идут до кода). Вручную:

```bash
psql "$DATABASE_URL" -f scripts/157_device_push_tokens.sql
```

## Шаг 3. Сборка оболочки (на вашей машине)

```bash
cd native
npm install

# Куда смотреть оболочке и как называться:
export CAP_SERVER_URL="https://ВАШ-ПРОД-ДОМЕН"
export CAP_APP_ID="app.omnidesk.mobile"      # = APNS_BUNDLE_ID
export CAP_APP_NAME="Omnidesk"

npm run add:ios       # создаёт native/ios   (нужен macOS)
npm run add:android   # создаёт native/android
npm run sync
```

> `CAP_SERVER_URL`, `CAP_APP_ID`, `CAP_APP_NAME` читаются в `capacitor.config.ts`
> в момент `cap add`/`cap sync`. Меняете окружение — просто пересоберите с новыми
> значениями, файл править не нужно.

### iOS

1. `npm run open:ios` — откроется Xcode.
2. Signing & Capabilities → добавьте **Push Notifications** и **Background Modes
   → Remote notifications**.
3. Bundle Identifier должен совпадать с `CAP_APP_ID` / `APNS_BUNDLE_ID`.
4. Выберите свою команду разработчика (Team), затем Archive → распространение
   через App Store Connect / TestFlight.

### Android

1. Firebase Console → добавьте Android-приложение с тем же package name, что
   `CAP_APP_ID`, скачайте `google-services.json` и положите в
   `native/android/app/google-services.json`.
2. `npm run sync:android && npm run open:android` — откроется Android Studio.
3. Build → Generate Signed Bundle/APK → `.aab` (для Google Play) или `.apk`
   (раздать напрямую — внутренний инструмент).

## Как это работает вместе

1. Оболочка грузит `CAP_SERVER_URL` в WebView (сессия по cookie).
2. ОС выдаёт push-токен → `lib/capacitor-push.ts` шлёт его на
   `/api/native-push/register` под текущей сессией.
3. Входящее сообщение → `push-dispatcher` → `sendNativePushToManager` →
   APNs/FCM → баннер на телефоне. Тап открывает нужный диалог (`data.url`).
4. Логаут → `unregisterNativePush` удаляет токен, доставка на это устройство
   прекращается.

## Иконки и сплэш

Положите `native/assets/icon.png` (1024×1024) и `native/assets/splash.png`
(2732×2732) и прогоните `npx @capacitor/assets generate` — сгенерирует все
размеры под обе платформы.
