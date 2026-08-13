# AGENTS.md — единая инструкция для ИИ-агента по проекту OMNIDESK

> Читай этот файл ПЕРВЫМ при заходе в проект в новом чате. Он объясняет, что
> это за система, кто в ней работает, где что лежит, какие правила нельзя
> нарушать и как безопасно вносить изменения. После значимых изменений
> обновляй его — это живой документ.

## 1. Что это за проект

OMNIDESK — панель управления **ИИ-менеджером продаж**, который сам общается с
реальными клиентами компании в нескольких каналах: лайв-чат на сайте (виджет),
Telegram, WhatsApp, VK, MAX. Руководитель («админ») управляет продавцом
**словами**, через встроенный чат-ассистент. Ключевая идея: **у продавца нет
захардкоженного поведения** — тон, персона, правила, сценарии, тайминги
задаются из чата и хранятся в БД.

Две «личности» ИИ в проекте — не путать:

- **ИИ-менеджер (продавец)** — пишет реальным клиентам. Его «мозг» —
  `lib/ai/manager-brain.ts`.
- **Admin AI / co-pilot («копилот»)** — ассистент внутри админки, помогает
  руководителю настраивать продавца. Логика — `lib/ai-console/run-assistant.ts`.

## 2. Роли и разделы

| Роль | URL | UI | Кто это |
|---|---|---|---|
| `admin` | `/admin` | `components/admin/` | руководитель: все лиды, финансы, настройка ИИ, копилот, аккаунты, серверы |
| `manager` | `/app` | `components/manager/` | менеджер продаж: инбокс диалогов, автопилот, свои лиды |
| `curator` | `/curator` | `components/curator/` | **менеджер по кадрам** (в UI и разговоре его называют так): свои лид-карточки, статусы, комментарии |

Гейты ролей — `lib/auth.ts` (`requireAdmin` / `requireManager` /
`requireCurator`); чужая роль редиректится в свой раздел.

## 3. Технологический стек

- **Next.js 16** (App Router) + React 19, TypeScript, **Tailwind + shadcn/ui**.
- **PostgreSQL** — прямые SQL через хелпер `query()` в `lib/data/*` (никакого
  ORM). Миграции — обычные `.sql` в `scripts/`, сейчас до `132`.
- **AI SDK** (Vercel) + AI Gateway. Модель — строка (напр. `openai/gpt-4.1`),
  переопределяется настройкой из админки.
- **Worker** (`worker/`) — отдельный Node-процесс: GramJS (Telegram), боты
  VK/MAX, обработка джобов. Запускается через PM2.
- **PM2** (`ecosystem.config.js`) — 12 процессов: panel, worker, крон-джобы
  (sync-ads, retry-dead-letters, followup, curator-status, console-schedules,
  ai-health, retention), backup-db, db-vacuum, auto-deploy.
- **Vitest** — юнит-тесты рядом с кодом (`lib/**/*.test.ts` и
  `worker/src/**/*.test.ts`), сейчас ~298. Интеграционные —
  `tests/integration/*.test.ts` (`pnpm test:integration`): требуют
  `DATABASE_URL` (без него скипаются), проверяют гонку livechat-диалогов
  (миграция 128), IDOR-скоупинг сообщений/медиа, revocation сессий,
  передачу диалогов (включая гонку двух одновременных передач) и
  журнал аудита (миграция 129).
- **Виджет лайв-чата** — `widget-src/livechat.js`, собирается esbuild'ом
  (`scripts/build-widget.mjs`, minify) в `public/livechat.js`. НЕ редактируй
  `public/livechat.js` руками. `pnpm build` собирает виджет автоматически.
- **Деплой** — `deploy.sh` на VPS: git pull → install → миграции → build в
  `.next.new` → атомарный swap → PM2 reload. Миграции применяются ДО кода.

## 4. СВЯЩЕННЫЙ ИНВАРИАНТ: изоляция god-панели

В проекте есть **скрытая god-панель** (секретный URL `app/wijegniwjgwjog/`,
гейт `lib/god-gate.ts`, UI `components/admin/secret-*` и
`components/admin/god-messenger/`). Это личный инструмент владельца.

> Исторически рядом жил «симулятор клиентов» (`lib/client-sim/*`) — он
> **полностью удалён** миграцией `090_remove_client_simulator.sql`. Не
> восстанавливай его и не ссылайся на него в новом коде.

Железные правила:

1. **Обычная админка, менеджеры и Admin AI НЕ ДОЛЖНЫ знать о существовании
   god-панели.** Никаких ссылок, упоминаний, намёков в обычном UI и в
   промптах co-pilot.
2. **Admin AI (`lib/ai-console/*`) НЕ импортирует** `god-gate`, `secret-*`,
   `god-messenger`, `god-sites` — ни прямо, ни транзитивно. Закреплено тестом
   `lib/ai/isolation.test.ts` — не ломай его.
3. **Диалоги, созданные из god-инструментов, — ОБЫЧНЫЕ реальные диалоги** для
   продавца, аналитики, уроков и дожима. НЕ фильтруй их по `is_simulated`.
   «Изоляция» — про невидимость интерфейса, а НЕ про резку данных.
   (Частая ошибка — не повторяй её.)
4. **Гейт FAIL-CLOSED.** Без `SECRET_PANEL_PASSWORD` консоль отдаёт голый 404
   (страница и все god-API) и разлочить её нельзя вообще; ошибка «неверный
   пароль» неотличима от «пароль не настроен». Recovery только через env:
   задать `SECRET_PANEL_PASSWORD` на VPS и перезапустить процесс — никакого
   in-band восстановления по дизайну.
5. **Управляемые сайты** (вкладка «Сайты», `lib/god-sites.ts`, миграция 132) —
   часть god-панели и подчиняются всем правилам выше. Внешние HTML-витрины
   (напр. page3.html «Директ Про») хостятся на чужом домене и ЧИТАЮТ данные из
   `GET /api/ext/pages/{PAGE_ID}/state?period=` (+ опциональный SSE
   `/stream?token=`) — контракт строго read-only, страница НИЧЕГО не пишет.
   PAGE_ID = slug сайта, токен = одноразовый API-ключ (SHA-256-хэш в БД,
   показывается один раз при создании/ротации), передаётся Bearer'ом или
   `?token=` (SSE). Slug и токен матчатся ОДНИМ запросом: чужой/неверный
   токен неотличим от несуществующего slug — голый 404 (fail-closed, как
   гейт); 401 только при полностью отсутствующем токене. Все правки данных —
   только из вкладки «Сайты» (optimistic locking по revision). Server actions
   вкладки (`app/actions/admin-secret/sites.ts`) требуют god-cookie поверх
   requireAdmin и НЕ пишут в admin-видимый журнал аудита.

## 5. Карта директорий

```
app/                     Next.js App Router
  actions/               server actions. Крупные — БАРЕЛИ:
                         admin-accounts.ts → -telegram (телефон/QR-����огин, 2FA),
                           -bots (VK/MAX), -maintenance (статус/прокси/удаление),
                           -shared (хелперы, НЕ 'use server')
                         finance.ts → finance-workspace, finance-ads,
                           finance-vault, finance-shared
                         account.ts → account-profile, account-messaging,
                           account-media
                         leads-export.ts — Excel-выгрузки: exportLeadsExcelAction
                           (админ, все лиды), exportMyLeadsExcelAction
                           (менеджер по кадрам, свои) и
                           exportManagerLeadsExcelAction (менеджер, свои
                           с фильтрами периода/статуса)
                         lead-cards/ — actions лид-карточек (core и др.)
  admin/                 страницы админки
  app/                   страницы менеджера (инбокс, автопилот, лиды, встречи)
  curator/               страницы менеджера по кадрам: layout на общем
                         DashboardShell (сайдбар: Обзор, Настройки),
                         settings/ — «Мои ГЕО» (self-service города:
                         listMyCitiesAction/updateMyCitiesAction в
                         app/actions/managers.ts, UI
                         components/curator/my-geo-settings.tsx), профиль,
                         смена пароля, push, 2FA (общая карточка
                         shared/twofa-settings, как у менеджера в
                         app/settings)
  api/                   роуты: api/livechat/* (виджет: config — 10s TTL-кэш,
                         ingest — rate limit, avatar), api/cron/* (followup,
                         retry-dead-letters, sync-ads, curator-status,
                         console-schedules, ai-health — алерт при всплеске
                         ошибок мозга, retention — ночная чистка);
                         api/ext/pages/[page]/{state,stream} — read-only
                         REST+SSE контракт витрин page3.html (раздел 4 п.5,
                         fail-closed 404, PAGE_ID=slug + Bearer/?token=)
  wijegniwjgwjog/        СЕКРЕТНАЯ god-панель (раздел 4)
components/admin/        UI админки
  ai-console.tsx + ai-console/   чат копилота: контейнер + use-ai-console.ts;
                         SSE-транспорт — stream-assistant.ts поверх общего
                         клиента lib/console-core/stream-client.ts (его же
                         использует servers-console/stream-servers-assistant.ts)
  ai-*-tab.tsx           вкладки ИИ: settings, training, corrections,
                         enrollment, logs
  widget-editor-tabs.tsx + widget-editor/  редактор виджета (вкладка = файл)
  all-leads-section.tsx + leads/  «Все лиды»: контейнер + use-leads-data.ts
                         (фильтры/пагинация/поллинг/экспорт/передача),
                         leads-filter-bar, leads-period-filter, xlsx-download
  finance/               финансы: expenses-panel + expenses/use-expenses.ts,
                         vault-panel + vault-card + vault-dialog (сейф паролей),
                         ads-panel.tsx + ads-panel/ — рекламные кабинеты:
                         контейнер + ad-account-card (карточка кабинета,
                         пополнение/статистика) + ads-summary-table (сводка)
  os-shell/              ОС-шелл god-панели: os-shell + use-os-shell.ts
  create-account-card.tsx + create-account/  подключение TG-аккаунта
  settings/              настройки админа: system-health-section (метрики из
                         lib/data/health-metrics), audit-log-section (журнал
                         действий из lib/data/audit)
  finance-admin.tsx + finance/use-finance-admin.ts  финансы: контейнер +
                         хук состояния (view/диалоги/фильтрация по ресурсу)
  lead-inline-edit.tsx + lead-inline-edit/use-inline-save.ts  инлайн-
                         редакторы лида; общий transition+toast флоу — в хуке
components/shared/       кросс-ролевые компоненты; use-xlsx-export.ts — общий
                         флоу Excel-выгрузки (admin/manager/curator leads);
                         slide-over.tsx — ЕДИНЫЙ шелл боковых панелей/шитов
                         (transform-only анимация, см. стандарт UI в разделе 10);
                         settings-shell.tsx — ЕДИНЫЙ шелл страниц настроек всех
                         ролей: свой сайдбар-вкладки справа (ездящая подсветка),
                         панели живут в DOM (серверный контент сохраняется),
                         диплинк через #tab-id
  secret-*, god-messenger/   UI god-панели (ИЗОЛИРОВАНО);
                         secret-sites-tab + secret-sites/site-editor —
                         вкладка «Сайты»: список/ключи + полный редактор
                         состояния кабинета (баланс, кампании, периоды)
components/curator/      UI менеджера по кадрам
  curator-leads-view.tsx «Мои лиды»: вкладки активные/архив, фильтры,
                         клиентский поиск, Excel-экспорт (как у админа)
  lead-detail-panel.tsx + lead-detail/  боковая карточка лида;
                         lead-transfer-section — передача лида коллеге-куратору
                         (transferMyLeadAction: владение проверяется под
                         row-lock, initiated_by_role='curator')
components/manager/      UI менеджера
  inbox-view.tsx + inbox/  инбокс: use-inbox.ts (выбор, черновики, realtime),
                         use-inbox-shortcuts.ts (j/k, Alt+стрелки),
                         use-thread-scroll.ts — автоскролл треда по НАМЕРЕНИЮ
                         пользователя: жест вверх (wheel/touch) мгновенно
                         снимает прилипание, программные скроллы флагуются и
                         не меняют intent, re-stick только у самого низа
                         (<40px) с мёртвой зоной 40–120px. НЕ возвращай
                         position-only логику — она даёт цикл «утаскивает
                         вниз при скролле вверх» (тот же паттерн в
                         god-messenger/use-god-scroll.ts);
                         thread-search.tsx — тел��грам-поиск по диалогу
                         (лупа в шапке) и навигация по кружкам/фото с
                         прикреплением к карточке лида: hits от новых к
                         старым, цель д��гружается loadOlder-циклом,
                         подсветка через data-message-id в message-list;
                         связь с LeadCardPanel — CustomEvent
                         'omnidesk:lead-attachments-changed';
                         lead-card-panel.tsx + lead-card/ — карточка лида:
                         контейнер + use-lead-card.ts (состояние формы,
                         сохранение, вложени��) + lead-card-form (поля) +
                         lead-card-details (детали/история)
  autopilot-manager.tsx + autopilot/  автопи��от: use-autopilot.ts, rule-editor
components/
  dashboard-shell.tsx    каркас разделов (сайдбар, мобильный лист, топбар);
                         навигация с «жидкой» подсветкой — dashboard-nav.tsx
  analytics/             activity-chart.tsx (по дням, пан/зум) +
                         activity-hour-chart.tsx (почасовой) + chart-math.ts
lib/
  ai/                    manager-brain.ts (мозг продавца), deal-heat.ts
                         (температура сделок 0–100, без модели),
                         assemble-brain-input.ts — ЕДИНСТВЕННАЯ сборка входа
                         мозга (раздел 7), isolation.test.ts;
                         ai-lead-run.ts — ЕДИНСТВЕННЫЙ оркестратор AI-lead
                         хода (эскалация → генерация → отправка → память →
                         readiness) с single-flight + dirty-флагом: сообщение
                         клиента, пришедшее во время in-flight генерации, НЕ
                         теряется — по завершении запускается один повторный
                         проход со свежей историей. Оба рантайма (livechat
                         lib/autopilot/runtime.ts и worker
                         autopilot-ai-lead.ts) — тонкие адаптеры над ним; НЕ
                         дублируй пайплайн в рантаймах. In-flight
                         реестр module-scoped — процесс с AI-lead должен быть
                         ОДИН (pm2 cluster детектится и фейлится fail-fast,
                         как в rate-limit.ts). brain/assess.ts: у
                         detectEscalation есть дешёвый эвристический
                         пре-фильтр clientShowsEscalationSignal (злость/
                         «позовите человека»/повторы) — модель зовётся только
                         при сигнале, НЕ на каждый inbound (латентность/цена)
  ai-console/            Admin AI: run-assistant.ts (30+ инструментов + промпт),
                         assistant.ts (типы действий/ревертов)
  admin-console/         ОС-шелл-копилот всей админки (кроме god-панели)
  servers-console/       ассистент вкладки «Серверы» (флот, установка, SSH)
  console-core/          общее ядро разговорных консолей; stream-client.ts —
                         единый клиентский SSE-парсер delta/meta/error для
                         всех консолей (не дублируй его в компонентах)
  autopilot/             маршрутизация правил и запуск ответов (runtime, match)
  followup/              runtime.ts — авто-дожим молчунов (ВЫКЛ по умолчанию)
  finance/               рекламные кабинеты, пополнения, статистика
  data/                  слой БД. Крупные — БАРЕЛИ (импорты не менять):
                         ai-assist.ts → -settings, -metrics, -lessons,
                           -history, -enrollment, -knowledge (RAG)
                         lead-cards.ts → -queries, -archive, -upsert,
                           -lifecycle (+ listLeadCardsForCurator и
                           listArchivedLeadsForCurator для куратора)
                         lead-admin.ts — «Все лиды» админа: фильтры, единый
                           поиск (дата/ФИО/телефон/@username/город/регион/
                           имя сотрудника — менеджера И менеджера по кадрам)
                         conversations.ts → conversation-transfer.ts
                           (передача диалогов, admin bulk reassignment),
                           conversation-messages.ts (чтение/запись сообщений
                           треда: hydration, batch preload, older-paging,
                           поиск, SSE gap recovery, addMessage),
                           message-admin.ts (dispatch/reactions/edit)
                         analytics.ts → analytics-admin.ts (админ-просмотр
                           диалогов БЕЗ manager-скоупа + активность
                           менеджеров; только за admin-гейтом),
                           analytics-groups.ts (группы источников)
                         shared.ts → shared-converters.ts (row → domain
                           маппинги toManager/toChannel/toConversation/toMessage)
                         brain-loaders.ts — next-сторона BrainInputLoaders
                         hosting.ts → hosting-deployments.ts (история деплоев,
                           стрим логов, очередь deploy_jobs)
                         audit.ts — общий журнал действий (audit_log, миграция
                           129): writeAudit НИКОГДА не кидает (fire-and-forget),
                           god-панель НЕ пишет в аудит (изоляция, раздел 4);
                           admin-audit.ts — старый лог только для servers-console
                         health-metrics.ts — метрики для вкладки «Здоровье
                           системы» в настройках админа (p95 мозга, очереди,
                           dead letters, свежесть кронов)
                         прочее: ai-directives, ai-followup, ai-analytics,
                         ai-log (ai_logs), console-shell, jobs
                         (enqueueJob — идемпотентность отправки, миграция 126)
  http/                  request.ts — zod-валидация входящих JSON
  hooks/                 клиентские хуки: use-shared-poll (ОБЩИЙ поллер — один
                         interval на канал, скрытые вкладки молчат; используй
                         его вместо своих setInterval; pokeSharedPoll — пуш-пинок
                         поллера извне), use-lead-events (SSE-события 'lead' →
                         пинок поллера лидов, миграция 127), use-channel-status,
                         use-debounced-value
  types/                 общие TS-типы по доменам, барель index.ts.
                         Импорт: @/lib/types
  time.ts                ЕДИНСТВЕННОЕ место форматирования дат (MSK):
                         formatMskDateTime / -Full / -Numeric, formatMskDate,
                         mskDayKey. НЕ определяй локальные formatDate в
                         компонентах — импортируй отсюда. Исключение:
                         finance-utils.tsx (даты-строки YYYY-MM-DD без TZ)
  outbound-dispatch.ts   роутер исходящей доставки: один lookup channel_type →
                         нужный диспетчер. НЕ перебирай все диспетчеры подряд.
  vk.ts                  БАРЕЛЬ VK Bot API → vk-core.ts (callApi, retry,
                         прокси, лонгполл-настройки) и vk-media.ts (скачивание
                         и загрузка вложений). Импорты через @/lib/vk.
  god-gate.ts            гейт god-панели (ИЗОЛИРОВАН)
  god-sites.ts           данные управляемых сайтов-витрин (ИЗОЛИРОВАН,
                         раздел 4 п.5): PAGE_ID=slug + токен (sha-256, матч
                         одним запросом), санитизация state, optimistic
                         locking по revision (только god-редактор — контракт
                         страницы read-only), проекция периодов stateForPeriod
                         (today живой, yesterday = день целиком, week/month/all
                         = СУММА посуточных симуляций — якорь «всего времени»
                         autoSpend.startDay; ручные periodOverrides
                         накладываются поверх и побеждают). last_seen_at
                         троттлится (touch не чаще раза в 30с). ВНИМАНИЕ:
                         шапка-комментарий scripts/132_god_sites.sql описывает
                         СТАРЫЙ контракт с мутациями от страницы — он
                         устарел, но файл менять НЕЛЬЗЯ (migrate.mjs сверяет
                         checksum применённых миграций и упадёт). Контракт
                         строго read-only, источник истины — раздел 4 п.5.
  god-sites-sim.ts       ЧИСТАЯ математика авто-скрутки (кривая часов, jitter,
                         autoDayKey/autoDayFraction) без server-only — общая
                         для сервера и превью god-редактора (не дублируй
                         кривую в компонентах). Тоже ИЗОЛИРОВАН (раздел 4)
  twofa.ts               2FA сотрудников (менеджер/менеджер по кадрам):
                         TOTP (секрет AES-256-GCM) или свой Telegram-бот
                         (BotFather, код через Bot API), backup-коды (bcrypt).
                         Обходы 2FA НАМЕРЕННЫ: врем. пароль из god-панели и
                         admin master-login (продуктовое требование)
  twofa-pending.ts       короткий ��одписанный cookie между шагом пароля и
                         шагом кода (5 мин, НЕ сессия)
  data/lunch.ts          обед/доступность менеджеров: advisory-lock на
                         «уйти на обед», round-robin подмена диалогов,
                         фильтр role='manager' (кураторы не в пуле)
  auth.ts, db.ts         сессии/роли; query() и withTransaction. Админ:
                         ADMIN_PASSWORD_HASH (bcrypt) предпочтительнее
                         plaintext; admin-session.ts — версия сессии из
                         credential-материала (ротация пароля/nonce отзывает
                         все admin-JWT)
  client-ip.ts           ЕДИНСТВЕННЫЙ экстрактор клиентского IP (TRUST_PROXY,
                         CF-Connecting-IP / X-Real-IP / последний hop XFF,
                         синтаксическая валидация). Не дублируй логику.
  rate-limit.ts          rate limiting публичных роутов. In-memory корректен
                         для ОДНОГО процесса; pm2 cluster детектится и в
                         production без Redis — fail-fast
                         (RATE_LIMIT_REQUIRE_REDIS=true для внешних балансеров)
  media-store.ts         ярусы хранения медиа: S3 (MEDIA_S3_*) → диск
                         (MEDIA_STORE_DIR) → bytea; локатор s3://… или
                         абсолютный путь, диспатч по префиксу (media-s3.ts)
worker/src/              воркер каналов
  telegram.ts            жизненный цикл соединения; флоу вынесены:
                         telegram-phone-login.ts (sendCode/SignIn/2FA),
                         telegram-qr-login.ts (QR-флоу целиком: begin, токены,
                         DC-миграция), telegram-lifecycle.ts (online/stop/
                         logout/zombie-переходы), telegram-health.ts
                         (зомби-детектор, Ping RPC), telegram-recovery.ts
                         (redelivery с дедуп-гардом), telegram-history.ts
                         (dialog sync, watermarks), telegram-throttle.ts
                         (пейсинг отправки + FLOOD_WAIT), telegram-errors.ts,
                         telegram-config.ts
  repo.ts                БАРЕЛЬ → repo-jobs, repo-channels, repo-proxies,
                         repo-telegram-cache, repo-messages (ingest; статусы
                         доставки и recovery-запросы — repo-message-status.ts)
  repo-ai.ts             БАРЕЛЬ → repo-ai-config (30s TTL-кэш конфига мозга),
                         repo-ai-context, repo-ai-autopilot, repo-ai-logs
  brain-loaders.ts       worker-сторона BrainInputLoaders
  autopilot.ts, jobs.ts  запуск ИИ-ответов, обработка джобов; вынесены
                         autopilot-ai-lead.ts (тонкий адаптер над
                         lib/ai/ai-lead-run.ts: skip-гейты воркера + лоадеры/
                         сендер; single-flight и dirty-повтор — в оркестраторе)
                         и autopilot-pacing.ts (typing-пейсинг)
  hosting/               автономный DevOps-агент: agent.ts (петля инструментов),
                         agent-prompts.ts (toolDefs + системный промпт), ssh.ts,
                         pipeline.ts, agent-safety.ts (блок опасных команд)
  telegram-*.test.ts     тест-харнесс на моках GramJS: phone-login (resume/
                         code/2FA/рестарт), qr-login (токен, DC-миграция,
                         2FA hand-off), recovery (дедуп, OFFLINE-маркер)
widget-src/livechat.js   ИСХОДНИК виджета (public/livechat.js — генерат)
scripts/                 SQL-миграции NNN_*.sql, migrate.mjs, cron-*.mjs,
                         build-widget.mjs, backup-db.mjs
deploy.sh                деплой на VPS (миграции ДО свапа кода)
ecosystem.config.js      PM2: все процессы и крон-расписания
```

## 6. Admin AI (co-pilot) — как расширять

- **Точка входа:** `lib/ai-console/run-assistant.ts` — `prepareAssistantRun`
  собирает `tools` и `SYSTEM_INSTRUCTIONS`.
- **Типы действий/ревертов:** `lib/ai-console/assistant.ts`
  (`ExecutedAction['kind']`, `SettingsRevert`). Новый вид действия — ��десь
  + иконка в карте иконок `components/admin/ai-console.tsx`.
- **Что умеет:** настройки (enabled/tone/persona/aggressiveness/model/params),
  директивы (remember/list/update/toggle/forget/reorder), база знаний, уроки,
  диалоги (list/attach/detach), аналитика (performance/cost/dealTemperature),
  дожим (status/configure, тихие часы, часовой пояс), отчёты (`exportReport`
  md/csv через `report` в `AssistantResult`), `previewReply`,
  `generateScenario`.
- **Рискованные действия гардируются:** выключение ИИ, дожим уровня 3,
  включение авто-дожима возвращают `needsConfirmation` (через `pending`),
  UI показывает кно��ку подтверждения.
- **Стиль промпта:** русский, тёплый, «ведёт админа за руку», финальное слово
  за админом.
- **Новый инструмент:** `tool({...})` с понятным русским `description`,
  данные �� ТОЛЬКО через `lib/data/*` (не пиши SQL в инструменте), запись в
  `actions`, при необходимости — в `SYSTEM_INSTRUCTIONS`.

## 7. ИИ-менеджер (продавец) — как устроен

- **Мозг:** `lib/ai/manager-brain.ts` — `generateManagerReply(input, log,
  config)`. Модель/temperature/maxTokens из `BrainConfig` (настройка админки
  приоритетнее env).
- **Приоритет в промпте:** персона → **директивы (высший приоритет)** → база
  знаний → уроки → агрессивность.
- **Сборка входа мозга** (lessons + corrections + history + memory +
  knowledge + directives) — в ОДНОМ месте: `lib/ai/assemble-brain-input.ts`.
  Все три рантайма (лайв-чат `lib/autopilot/runtime.ts`, воркер
  `worker/src/autopilot.ts`, дожим `lib/followup/runtime.ts`) вызывают её
  через свои `BrainInputLoaders`. Меняешь лимиты/состав/RAG — ТОЛЬКО там.
  Для ��атчей: `loadSharedBrainContext` один раз → `assembleBrainInput` с
  `{ shared }` на диалог. RAG-запрос — последнее сообщение клиента; пустая
  строка НИКОГДА не эмбеддится (платный вызов ради мусора).
- **Single-flight-гард** (`lib/autopilot/runtime.ts`,
  `worker/src/autopilot.ts`): claim в `aiLeadInFlight` берётся **синхронно,
  сразу после `has()`, без await между ними** — иначе гонка и двойной ответ.
  `finally` снимает claim. Не «оптимизируй» это.
- **Исходящая доставка:** всегда `deliverOutboundByChannel` из
  `lib/outbound-dispatch.ts`.
- **Идемпотентность отправки** (миграция 126): не более одного живого
  (queued/running) `send_message`-джоба на `payload.messageId` — уникальный
  частичный индекс; `enqueueJob` при конфликте возвращает живой джоб.
  Двойная доставка клиенту невозможна на уровне БД.
- **Follow-up:** ВЫКЛ по умолчанию, тихие часы + лимит касаний + дедуп,
  крон `app/api/cron/followup/`. Общие данные грузятся один раз до цикла.
- **Deal-heat:** `lib/ai/deal-heat.ts` — детерминированный скоринг без модели.

## 8. База данных и миграции

- Схема — `scripts/NNN_*.sql`, нумерация до `128`. Исторические пропуски
  (001→003, 026→030, 035→037) — НЕ ошибка, не переиспользуй номера.
- Новая миграция: следующий свободный номер, применение `pnpm db:migrate`
  (статус `pnpm db:status`). На проде применяет `deploy.sh` ДО свапа кода.
- Настройки ИИ — singleton-строка `ai_assist_settings` (id=true).
- Данные — ТОЛЬКО через `lib/data/*`, параметризованными запросами.
- **Многошаговые мутации — только `withTransaction`** (`lib/db.ts`): delete +
  пересчёт счётчиков и т.п. оборачивай в транзакцию.
- Unread считается точно через `messages.read_at` (миграция 125).
- **Ретеншн:** `/api/cron/retention` (04:10, после бэкапа):
  ai_generation_metrics 365д, admin_audit_log 180д, hosting_deploy_logs 30д,
  завершённые channel_jobs 7д.
- **Алертинг мозга:** `/api/cron/ai-health` (каждые 10 мин): доля ошибок за
  час из `ai_logs`; при ≥30% на ≥5 попытках — маркер health.alert + опц.
  Telegram (`TELEGRAM_ALERT_BOT_TOKEN`/`TELEGRAM_ALERT_CHAT_ID`), кулдаун 6ч.
- **Realtime лидов** (миграция 127): триггер на `lead_cards` → pg_notify
  'realtime' (событие `lead` с manager_id/curator_id) → `/api/stream`
  доставляет по роли (админ — все) → клиент пинает shared-поллер через
  `pokeSharedPoll`. Поллинг вьюх лидов — редкий фолбэк (60с), не основной
  механизм. Инбокс живёт на своих событиях message/conversation.

## 9. Команды проверки (запускай перед завершением)

```
pnpm typecheck          # tsc --noEmit (основной проект)
pnpm typecheck:worker   # воркер
pnpm lint               # eslint
pnpm test               # vitest (lib + worker)
pnpm check              # всё сразу — ДОЛЖЕН быть зелёным перед пушем
```

БД в песочнице обычно НЕ подключена (`ECONNREFUSED 127.0.0.1:5432` — норма):
миграции применяет `deploy.sh` на VPS. Проверяй SQL статически.

## 10. Правила работы в этом репозитории

- **Ветка:** пользователь просит пушить прямо в `main` и не плодить ветки —
  следуй его явному указанию.
- **Кириллица/UTF-8:** после правок промптов и текстов проверяй
  `grep -rlP '\xEF\xBF\xBD' lib components app worker/src scripts AGENTS.md`
  — должно быть пусто (битые символы уже случались).
- **Никакого хардкода поведения продавца** — любое новое поведение это
  настройка, директива или урок из чата, а не константа в коде.
- **Не удаляй и не обходи** тест изоляции `lib/ai/isolation.test.ts`.
- **Конвенция декомпозиции:** клиентская логика тяжёлого компонента — в хук
  `use-*.ts` рядом, компонент остаётся презентационным; верстка режется на
  подкомпоненты в подпапке; крупные модули данных/типов дробятся по доменам
  с барелем (импорты не меняются). Рефакторинг = «переставить, не менять
  п��ведение»: дословный перенос + `pnpm check`. Кандидат на декомпозицию —
  файл >~700 строк ИЛИ смешение несвязанных доменов.
- **UI-конв��нция строк фильтров:** контролы h-9, иконки `size-4 shrink-0`
  (выровнено в «Все лиды» и «Мои лиды» — поддерживай при добавлении кнопок).
- **СТАНДАРТ UI «как у Apple» — скорость и плавность обязательны.** Любые
  панели, шиты, оверлеи �� модалки открываются мгновенно и без единого
  дёрганого кадра. Правила:
  - Боковые панели/шиты — ТОЛЬКО через общий `components/shared/slide-over.tsx`
    (панель всегда смонтирована, анимация `transition-transform` +
    `transition-opacity` — чистый GPU-композитинг, ленивы�� mount контента).
    Не изобретай свои оверлеи с `animate-in`.
  - **НИКОГДА не анимируй `backdrop-blur`** (и вообще избегай blur на
    полноэкранных подложках) — пере-блюривание страницы каждый кадр и есть
    источник «глюков». Подложка затемняется только через `opacity`.
  - Анимируй только `transform` и `opacity`; никаких анимаций
    `width/height/top/left/box-shadow` на открытии.
  - Данные для деталей показывай мгновенно из уже загруженной строки списка
    (`fallbackData` в SWR), сеть догружает только недостающее — секции
    получают лёгкие скелетоны, глобального спиннера на панели быть не должно.
  - После мутации — ОДИН путь обновления: клиентский `refresh()`/`mutate()`.
    `revalidatePath` в actions дашбордов не использовать: страницы динамические
    (cookie-auth), клиент держит состояние в `useState` — серверный ре-рендер
    выбрасывается впустую (см. `app/actions/lead-cards/core.ts`).
  - Эталоны: docked-карточка в Inbox менеджера, `SlideOver` карточки лида.
  - **Select (base-ui, `components/ui/select.tsx`)**: Root-обёртка сама
    собирает `items` из `SelectItem`-детей, поэтому закрытый триггер всегда
    показывает человеческую надпись, а не сырое значение («transferred»).
    Если пункты рендерятся в отдельном подкомпоненте — передай `items`
    явно. Попап выпадает ПОД триггером (`alignItemWithTrigger=false`,
    `align="start"`) — не включай режим перекрытия обратно. Высота триггера —
    обычные классы (`h-8` дефолт), переопределяется `h-9` из className.
  - Кликабельным элементам курсор pointer даёт глобальное правило в
    `globals.css` (`button:not(:disabled)`), отдельно прописывать не нужно;
    исключение — «кликабельные» не-кнопки (li и т.п.): им `cursor-pointer`.
- **Поллинг в UI** — только через `lib/hooks/use-shared-poll.ts`.
- **Воркараунд GramJS:** `client.catchUp()` в библиотеке `telegram` — пустая
  заглушка; восстановление пропущенных сообщений сделано своим dialog sync с
  per-chat watermarks (миграция 105). При обновлении зависимости проверь,
  не реализовали ли `catchUp()`.
- **Только личные чаты в инбоксе:** группы/супергруппы/каналы TG отсекаются
  и в live-обработчике (`worker/src/telegram-updates.ts`), и в dialog sync
  (`worker/src/telegram-history.ts`); беседы VK (peer_id ≥ 2e9) — в
  `app/api/vk/webhook/[channelId]/route.ts`. Не возвращай ingest групп —
  это осознанное решение против мусора в инбоксе.
- Сапрессии `react-hooks/set-state-in-effect` (~18 файлов) — НЕ техдолг, а
  осознанные паттерны (browser-API на маунте, debounce, derived-state с
  замером DOM). Не «чини» их ради галочки.
- Сложную новую логику покрывай юнит-тестом рядом с кодом.

## 11. Частые задачи — с чего начать

| Задача | Где смотреть |
|---|---|
| Новая возможность Admin AI | `lib/ai-console/run-assistant.ts` (+ `assistant.ts`, иконка в `ai-console.tsx`) |
| Изменить поведение продавца | директивы `lib/data/ai-directives.ts` или промпт `lib/ai/manager-brain.ts` |
| Изменить вход мозга (лимиты, RAG) | ТОЛЬКО `lib/ai/assemble-brain-input.ts` (раздел 7) |
| Новая настройка ИИ | колонка в `ai_assist_settings` (миграция) → `lib/data/ai-assist-settings.ts` → инструмент co-pilot |
| Новый канал / воркер | `worker/src/*`, `lib/autopilot/*`, доставка — `lib/outbound-dispatch.ts` |
| БД-слой воркера | барели `worker/src/repo.ts` и `repo-ai.ts` |
| Подключение аккаунтов | барель `app/actions/admin-accounts.ts` |
| Лид-карточки (данные) | барель `lib/data/lead-cards.ts`; фильтры/поиск админа — `lib/data/lead-admin.ts` |
| «Все лиды» (админ) | `all-leads-section.tsx` + `components/admin/leads/use-leads-data.ts` |
| «Мои лиды» (менеджер по кадрам) | `components/curator/curator-leads-view.tsx` |
| «Мои лиды» (менеджер) | `components/manager/manager-leads-view.tsx` |
| Excel-выгрузки лидов | `app/actions/leads-export.ts` (три роли: админ / менеджер / менеджер по кадрам), клиент — `components/admin/leads/xlsx-download.ts` |
| Realtime лидов (push) | миграция 127 + `app/api/stream/route.ts` + `lib/hooks/use-lead-events.ts` |
| Карточка лида (куратор) | `lead-detail-panel.tsx` + `components/curator/lead-detail/*` |
| Инбокс менеджера | `inbox-view.tsx` + `components/manager/inbox/use-inbox.ts` (+ шорткаты `use-inbox-shortcuts.ts`) |
| Автопилот (UI) | `autopilot-manager.tsx` + `components/manager/autopilot/*` |
| Виджет лайв-чата | исходник `widget-src/livechat.js` → `pnpm build:widget`; конфиг-роут `app/api/livechat/config/` (TTL-кэш) |
| Редактор виджета | `components/admin/widget-editor/` |
| Финансы (actions / UI) | барель `app/actions/finance.ts`; UI `components/admin/finance/` |
| Аналитика/отчёты | `lib/data/ai-analytics.ts`, `lib/ai/deal-heat.ts` |
| Дожим молчунов | `lib/followup/runtime.ts`, `lib/data/ai-followup.ts` |
| Прочтение/unread | `messages.read_at` (миграция 125): штамп в `markConversationRead` и при ответе |
| Идемпотентность отправки | миграция 126 + `enqueueJob` в `lib/data/jobs.ts` |
| Алертинг мозга | `app/api/cron/ai-health/route.ts` |
| Ретеншн данных | `app/api/cron/retention/route.ts` |
| Крон/процессы | `ecosystem.config.js` (PM2) + `scripts/cron-*.mjs` |
| Хостинг/деплой на серверы | `lib/data/hosting.ts`, `worker/src/hosting/*` |
| ОС-шелл god-панели | `components/admin/os-shell/`, `lib/data/console-shell.ts` |
| god-панель | `app/wijegniwjgwjog/`, `components/admin/secret-*`, `god-messenger/` (раздел 4!) |
