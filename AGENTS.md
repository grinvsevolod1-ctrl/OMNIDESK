# AGENTS.md — инструкция для ИИ-агента по проекту OMNIDESK

> Этот файл — первое, что нужно прочитать при заходе в проект в новом чате.
> Он объясняет, что это за система, где что лежит, какие правила НЕЛЬЗЯ нарушать
> и как безопасно вносить изменения. Держи его в актуальном состоянии.

## 1. Что это за проект

OMNIDESK — панель управления **ИИ-менеджером продаж**, который сам общается с
реальными клиентами компании в нескольких каналах (лайв-чат на сайте, Telegram,
WhatsApp, VK, MAX). Руководитель («админ») управляет продавцом **словами**, через
встроенный чат-ассистент. Ключевая идея: **у продавца нет захардкоженного
поведения** — тон, персона, правила, сценарии, тайминги задаются из чата и
хранятся в БД.

Две «личности» ИИ в проекте — не путать:

- **ИИ-менеджер (продавец)** — пишет реальным клиентам. Его «мозг» —
  `lib/ai/manager-brain.ts`.
- **Admin AI / co-pilot** — ассистент внутри админки, помогает руководителю
  настраивать продавца. Его логика — `lib/ai-console/run-assistant.ts`.
  (В разговоре пользователь называет его «копилот» = Admin AI.)

## 2. Технологический стек

- **Next.js 16** (App Router) + React 19, TypeScript.
- **PostgreSQL** — прямые SQL-запросы через хелпер `query()` в `lib/data/*`
  (никакого ORM). Миграции — обычные `.sql` в `scripts/`.
- **AI SDK** (Vercel) + AI Gateway. Модели задаются строкой (напр.
  `openai/gpt-4.1`), переопределяются настройкой из админки.
- **Worker** (`worker/`) — отдельный Node-процесс: поллинг Telegram и других
  каналов, запускается через PM2 (`ecosystem.config.js`).
- **Vitest** — юнит-тесты (лежат рядом с кодом, `*.test.ts`).
- **Tailwind** + shadcn/ui — админка.

## 3. СВЯЩЕННЫЙ ИНВАРИАНТ: изоляция god-панели

В проекте есть **скрытая god-панель** (секретный URL `app/wijegniwjgwjog/`,
гейт `lib/god-gate.ts`, UI `components/admin/secret-*` и
`components/admin/god-messenger/`). Это личный инструмент владельца.

> Исторически рядом жил «симулятор клиентов» (`lib/client-sim/*`) — он
> **полностью удалён** миграцией `090_remove_client_simulator.sql`. Не
> восстанавливай его и не ссылайся на него в новом коде.

Железные правила:

1. **Обычная админка, менеджеры и Admin AI НЕ ДОЛЖНЫ знать о существовании
   god-панели.** Её нет ни для кого. Никаких ссылок, упоминаний, намёков в
   обычном UI и в промптах co-pilot.
2. **Admin AI (`lib/ai-console/*`) НЕ импортирует** `god-gate`, `secret-*`,
   `god-messenger` — ни прямо, ни транзитивно. Это закреплено тестом
   `lib/ai/isolation.test.ts` — не ломай его.
3. **Диалоги, созданные из god-инструментов, — это ОБЫЧНЫЕ реальные диалоги**
   для продавца, аналитики, уроков и дожима. НЕ фильтруй их по `is_simulated`.
   «Изоляция» — это про то, что god-панель как интерфейс невидима, а НЕ про то,
   что данные надо резать. (Это частая ошибка — не повторяй её.)

## 4. Карта директорий

```
app/                     Next.js App Router
  actions/               server actions (ai-console.ts, ai-assist.ts, ...)
                         admin-accounts.ts — БАРЕЛЬ, реэкспортирует
                         admin-accounts-telegram.ts (телефон/QR-логин, код, 2FA),
                         admin-accounts-bots.ts (VK/MAX-подключение),
                         admin-accounts-maintenance.ts (статус, прокси, удаление),
                         admin-accounts-shared.ts (общие хелперы, НЕ 'use server')
                         finance.ts — БАРЕЛЬ: finance-workspace.ts (ресурсы,
                         секции, записи, задачи), finance-ads.ts (рекламные
                         кабинеты, пополнения, статистика), finance-vault.ts
                         (сейф), finance-shared.ts (общие хелперы)
                         account.ts — БАРЕЛЬ: account-profile.ts (обед, смена
                         пароля), account-messaging.ts (отправка, прочтение,
                         отложенные), account-media.ts (голос, стикеры, медиа)
  admin/                 страницы админки
  api/                   роуты, включая api/cron/* (follow-up, dead-letters)
  wijegniwjgwjog/        СЕКРЕТНАЯ god-панель (см. раздел 3)
components/admin/        UI админки
  ai-console.tsx         чат Admin AI (копилот): презентационный контейнер;
  ai-console/            вся логика в use-ai-console.ts (стрим, подтверждения,
                         голос, пресеты, панели)
  ai-*-tab.tsx           вкладки: settings, training, corrections, enrollment, logs
  widget-editor-tabs.tsx БАРЕЛЬ; вкладки редактора виджета лежат в
  widget-editor/         appearance/content/messengers/hours/behavior-tab.tsx
                         + shared.tsx (общие контролы)
  all-leads-section.tsx  раздел «Все лиды»: презентационный контейнер
  leads/                 подкомпоненты + логика «Все лиды»: use-leads-data.ts
                         (хук: фильтры/пагинация/пуллинг/экспорт/передача),
                         leads-filter-bar, leads-period-filter, period-range,
                         xlsx-download, admin-lead-row
  finance/               финансы (UI): expenses-panel.tsx — контейнер, вся
                         логика в expenses/use-expenses.ts, строки и части
                         таблицы в expenses/ (expense-row, table-parts)
  os-shell/              ОС-шелл god-панели (командный интерфейс поверх админки):
                         os-shell.tsx — презентационный контейнер, вся логика в
                         use-os-shell.ts (стрим, подтверждения, голос, история),
                         command-bar, history-dialog, feed, data-views
  create-account-card.tsx карточка «Подключить аккаунт»: контейнер; логика в
  create-account/        use-create-account.ts (форма + многошаговый TG-логин
                         с поллингом), telegram-login-dialog.tsx (QR/код/2FA)
  secret-*               UI god-панели (ИЗОЛИРОВАНО)
  god-messenger/         god-мессенджер: диалоги от лица аккаунтов (ИЗОЛИРОВАНО)
components/curator/      UI куратора
  lead-detail-panel.tsx  боковая карточка лида: оркестратор (загрузка + действия)
  lead-detail/           подкомпоненты карточки: lead-identity, lead-fields,
                         lead-history (общий HistoryRow), lead-lifecycle-actions,
                         lead-comments, panel-section, format.ts, types.ts
components/manager/      UI менеджера
  inbox-view.tsx         инбокс: презентационный компонент
  inbox/use-inbox.ts     хук инбокса: выбор диалога, черновики, действия,
                         фильтры, realtime, derived-счётчики, гидрация треда
  autopilot-manager.tsx  автопилот: презентационный контейнер
  autopilot/             логика и части автопилота: use-autopilot.ts (хук:
                         CRUD правил, optimistic-обновления, reorder),
                         draft.ts (DraftState + константы), rule-editor,
                         rule-card
lib/
  ai-console/            Admin AI: run-assistant.ts (инструменты+промпт), assistant.ts (типы)
  admin-console/         ОС-шелл-копилот всей админки (кроме god-панели): командная строка
                         поверх панели, инструменты tools-*.ts, intents, schedule-runner
  servers-console/       разговорный ассистент вкладки «Серверы» (флот, установка, SSH)
  console-core/          общее ядро разговорных консолей (admin-console + servers-console)
  ai/                    manager-brain.ts (мозг продавца), deal-heat.ts
                         (температура сделок), assemble-brain-input.ts —
                         ЕДИНСТВЕННАЯ сборка входа мозга (см. раздел 6)
  data/                  слой БД. ai-assist.ts — БАРЕЛЬ, реэкспортирует доменные
                         модули (существующие импорты `@/lib/data/ai-assist`
                         менять не нужно):
                           ai-assist-settings.ts    настройки (singleton-строка)
                           ai-assist-metrics.ts     счётчики использования/стоимости
                           ai-assist-lessons.ts     уроки мозга
                           ai-assist-history.ts     история диалога + память
                           ai-assist-enrollment.ts  подключение ИИ к диалогам
                           ai-assist-knowledge.ts   база знаний + RAG (retrieveKnowledge)
                         lead-cards.ts — тоже БАРЕЛЬ:
                           lead-cards-queries.ts    выборки/статистика лид-карточек
                           lead-cards-archive.ts    архив и восстановление
                           lead-cards-upsert.ts     создание/обновление из диалога
                           lead-cards-lifecycle.ts  статусы, передача, комментарии
                         brain-loaders.ts — data-слой BrainInputLoaders для
                         assembleBrainInput (next-рантаймы).
                         Прочее: ai-directives.ts (правила), ai-followup.ts,
                         ai-analytics.ts, hosting.ts (серверы/приложения),
                         console-shell.ts (ОС-шелл)
  autopilot/             маршрутизация правил и запуск ответов (runtime.ts, match.ts)
  followup/              runtime.ts — авто-дожим молчунов
  finance/               финансы: рекламные кабинеты, пополнения, статистика расходов
  http/                  request.ts — валидация входящих JSON-запросов (zod)
  hooks/                 клиентские React-хуки (use-channel-status,
                         use-debounced-value, use-shared-poll — общий поллер:
                         один interval на канал, без наложения запросов,
                         скрытые вкладки не опрашивают; используй его вместо
                         собственных setInterval-поллеров)
  types/                 общие TS-типы, разнесённые по доменам с барелем
                         index.ts (accounts, channels, proxies, jobs, leads,
                         messages, conversations, hosting). Импорт: @/lib/types
  outbound-dispatch.ts   роутер исходящей доставки: один lookup channel_type →
                         нужный диспетчер (MAX/VK/WhatsApp; livechat — no-op).
                         НЕ вызывай три диспетчера подряд «на всякий случай».
  god-gate.ts            гейт god-панели (ИЗОЛИРОВАН)
worker/src/              воркер каналов (telegram.ts, autopilot.ts, jobs.ts, ...)
                         telegram.ts — жизненный цикл соединения (клиент,
                         string session, таймеры); флоу входа вынесены:
                         telegram-phone-login.ts (sendCode/SignIn/2FA — phone
                         и phoneCodeHash не покидают модуль),
                         telegram-qr-login.ts (QR: токены, скан-листенер,
                         DC-миграция); также telegram-health.ts (зомби-детектор,
                         Ping RPC), telegram-recovery.ts (redelivery после
                         реконнекта с дедуп-гардом), telegram-history.ts
                         (dialog sync, per-chat watermarks),
                         telegram-errors.ts, telegram-config.ts.
                         repo.ts — БАРЕЛЬ: repo-jobs.ts (джобы/dead-letters),
                         repo-channels.ts (каналы/сессии), repo-proxies.ts,
                         repo-telegram-cache.ts (кэш entity), repo-messages.ts.
                         repo-ai.ts — БАРЕЛЬ: repo-ai-config.ts (конфиг мозга,
                         30s TTL-кэш), repo-ai-context.ts (история/память/RAG),
                         repo-ai-autopilot.ts (правила, запуски),
                         repo-ai-logs.ts (логи ответов).
                         brain-loaders.ts — worker-сторона BrainInputLoaders
                         (директивы приходят из 30s TTL-кэша конфига).
  hosting/               автономный DevOps-агент: agent.ts (промпт+цикл), ssh.ts,
                         pipeline.ts, agent-safety.ts (блокировка опасных команд)
scripts/                 SQL-миграции NNN_*.sql + migrate.mjs + cron-*.mjs
```

## 5. Admin AI (co-pilot) — как устроен и как расширять

- **Точка входа:** `lib/ai-console/run-assistant.ts`. Здесь `prepareAssistantRun`
  собирает набор `tools` (сейчас 30+) и `SYSTEM_INSTRUCTIONS` (промпт).
- **Типы действий/ревертов:** `lib/ai-console/assistant.ts`
  (`ExecutedAction['kind']`, `SettingsRevert`). Новый вид действия добавляется
  ЗДЕСЬ + иконка в `components/admin/ai-console.tsx` (карта иконок).
- **Что умеет:** менять настройки (`setEnabled`, `setTone`, `setPersona`,
  `setAggressiveness`, `setModelParams`, `setModel`), правила-директивы
  (`rememberDirective`/`list`/`update`/`toggle`/`forget`/`reorder`), базу знаний
  (add/list/update/delete), уроки (add/list/delete), диалоги (`listDialogs`,
  `attachAi`, `detachAi`), аналитику (`getPerformance`, `getCostStats`,
  `dealTemperature`), дожим (`getFollowupStatus`, `configureFollowup` — включая
  тихие часы и `quietTz`/часовой пояс), выгрузку отчётов (`exportReport` — md/csv,
  скачивается кнопкой под сообщением через `report` в `AssistantResult`),
  предпросмотр ответа (`previewReply`), генерацию сценария (`generateScenario`).
  Директивы также видны в UI настроек в режиме «только чтение»
  (`aiListDirectivesAction` → карточка в `components/admin/ai-settings-tab.tsx`).
- **Рискованные действия ГАРДИРУЮТСЯ:** выключение ИИ, максимальный дожим
  (уровень 3), включение авто-дожима — возвращают `needsConfirmation` (через
  `pending`), а не применяются сразу. UI показывает кнопку подтверждения.
- **Стиль промпта:** русский, тёплый, «ведёт админа за руку», объясняет простым
  языком, предлагает следующий шаг, честно предупреждает об ошибках, но финальное
  слово за админом.
- **Добавляя новый инструмент:** напиши `tool({...})` с понятным русским
  `description` (по нему модель решает, когда вызывать), опиши триггерные фразы,
  протолкни изменение через существующие функции `lib/data/*` (не пиши SQL прямо в
  инструменте), добавь запись в `actions` и, при необходимости, документируй в
  `SYSTEM_INSTRUCTIONS`.

## 6. ИИ-менеджер (продавец) — как устроен

- **Мозг:** `lib/ai/manager-brain.ts` — `generateManagerReply(input, log, config)`.
  Модель/temperature/maxTokens берутся из `BrainConfig` (настройка админки имеет
  приоритет над env-дефолтами).
- **Приоритет входных данных в промпте:** персона → **директивы (правила от
  админа, высший приоритет)** → база знаний → уроки → агрессивность.
- **Сборка входа мозга** («lessons + corrections + history + memory +
  knowledge + directives») живёт в ОДНОМ месте — `lib/ai/assembleBrainInput`
  (`lib/ai/assemble-brain-input.ts`). Все три рантайма (лайв-чат
  `lib/autopilot/runtime.ts`, воркер `worker/src/autopilot.ts`, дожим
  `lib/followup/runtime.ts`) вызывают её через свои `BrainInputLoaders`
  (`lib/data/brain-loaders.ts` для next, `worker/src/brain-loaders.ts` для
  воркера). Меняешь лимиты, состав или выбор RAG-запроса — меняй ТОЛЬКО там,
  НЕ создавай локальные копии сборки. Для батчей (дожим) сначала
  `loadSharedBrainContext` один раз, потом `assembleBrainInput` с `{ shared }`
  на каждый диалог. RAG-запрос — последнее сообщение клиента; пустая строка
  никогда не эмбеддится (платный вызов ради мусора).
- **Директивы** (`lib/data/ai-directives.ts`, таблица `ai_directives`) вливаются
  во ВСЕ каналы автоматически через эту сборку; в воркере они дополнительно
  идут через 30-секундный TTL-кэш конфига.
- **Single-flight-гард ИИ-ответов** (`lib/autopilot/runtime.ts` и
  `worker/src/autopilot.ts`): claim в `aiLeadInFlight` берётся **синхронно,
  сразу после `has()`, без единого `await` между ними** — иначе гонка и двойной
  ответ клиенту. `finally` снимает claim. Не «оптимизируй» это обратно.
- **Исходящая доставка:** всегда через `lib/outbound-dispatch.ts`
  (`deliverOutboundByChannel`) — один запрос channel_type вместо перебора всех
  диспетчеров.
- **Follow-up** (`lib/followup/runtime.ts`): дожимает молчунов, ВЫКЛ по умолчанию,
  тихие часы + лимит касаний + дедуп, гоняется cron-роутом
  `app/api/cron/followup/route.ts` (+ `scripts/cron-followup.mjs`, PM2).
  Конвенции цикла: данные, не зависящие от диалога (уроки, коррекции,
  директивы), грузятся ОДИН раз до цикла по кандидатам; `retrieveKnowledge`
  вызывается только с непустым запросом (последнее сообщение клиента) —
  embedding пустой строки — это платный вызов ради мусора.
- **Deal-heat** (`lib/ai/deal-heat.ts`): детерминированный скоринг «горячести»
  сделки 0–100 по реальным сигналам, без вызова модели.

## 7. База данных и миграции

- Схема живёт в `scripts/NNN_*.sql` (нумерация возрастает, сейчас до `121`).
  В нумерации есть исторические пропуски (напр. 001→003, 026→030, 035→037) —
  это НЕ ошибка, не «чини» их и не переиспользуй пропущенные номера.
- Новая миграция: создай `scripts/NNN_описание.sql` со следующим свободным
  номером, применяется через `pnpm db:migrate` (статус — `pnpm db:status`).
  `migrate.mjs` находит файлы по префиксу-номеру.
- Настройки ИИ — singleton-строка в `ai_assist_settings` (id=true).
- Читай/пиши данные ТОЛЬКО через `lib/data/*`, параметризованными запросами.
- **Многошаговые мутации — только в `withTransaction`** (`lib/db.ts`): если
  вторая команда зависит от первой (delete + пересчёт счётчиков/превью),
  оборачивай в транзакцию, чтобы сбой посередине не оставил рассинхрон
  (пример: `app/actions/admin-secret/conversation-edits.ts`).

## 8. Команды проверки (запускай перед завершением)

```
pnpm typecheck          # tsc --noEmit (основной проект)
pnpm typecheck:worker   # воркер
pnpm lint               # eslint
pnpm test               # vitest (юнит)
pnpm check              # всё сразу: lint + typecheck + typecheck:worker + test
```

БД в песочнице обычно не подключена — миграции применяет пользователь на VPS
через `pnpm db:migrate` при деплое.

## 9. Правила работы в этом репозитории

- **Ветка по умолчанию:** `main`. Пользователь этого проекта просит пушить
  изменения прямо в `main` и не плодить лишние ветки — следуй его явным указаниям.
- **Кириллица в промптах:** будь аккуратен с UTF-8. В прошлом в строках промптов
  появлялись «битые» символы (replacement character, U+FFFD). После правок
  промптов проверяй: `grep -rlP '\xEF\xBF\xBD' lib` — должно быть пусто.
- **Никакого хардкода поведения продавца.** Любое новое поведение — это настройка,
  директива или урок, управляемые из чата, а не константа в коде.
- **Не удаляй и не обходи** тест изоляции `lib/ai/isolation.test.ts`.
- Меняй только то, что нужно; сложную логику покрывай юнит-тестом рядом.
- **Конвенция декомпозиции монолитов** (сложилась при рефакторинге лидов/инбокса,
  продолжена на автопилоте и финансах): вся клиентская логика тяжёлого
  компонента выносится в хук `use-*.ts` рядом, сам компонент остаётся
  презентационным; верстка режется на подкомпоненты в подпапке; крупные модули
  типов/данных дробятся по доменам с барелем (пример: `lib/data/ai-assist.ts`),
  чтобы существующие импорты не менялись. Рефакторинг = «переставить, не менять
  поведение»: JSX и логика переносятся дословно, проверяется `pnpm check`.
- **Воркараунд GramJS:** `client.catchUp()` в библиотеке `telegram` — пустая
  заглушка, поэтому восстановление пропущенных сообщений в
  `worker/src/telegram.ts` сделано через собственный dialog sync с per-chat
  watermarks (миграция 105). При обновлении зависимости `telegram` проверь,
  не реализовали ли `catchUp()` — тогда воркараунд можно упростить.

## 10. Известный техдолг

Волны декомпозиции ЗАВЕРШЕНЫ: telegram.ts (~780 строк — вынесены health,
recovery, QR-логин и phone/code login-флоу; dialog sync давно живёт в
telegram-history.ts), repo.ts и repo-ai.ts (доменные модули с барелями),
finance/account actions, widget-editor-tabs (вкладки по файлам), ai-console
(use-ai-console), lead-cards, admin-accounts, os-shell, create-account-card,
ai-assist, autopilot-manager, expenses-panel; `assembleBrainInput` вынесен в
`lib/ai/`; поллинг лидов переведён на `use-shared-poll`; unread
пересчитывается точно через `messages.read_at` (миграция 125).

Отдельного списка «что осталось» больше нет. Новые кандидаты появляются,
когда файл перерастает ~700 строк ИЛИ смешивает несвязанные домены — тогда
рефактори осознанной задачей, дословным переносом, с `pnpm check` после.

Сапрессии `react-hooks/set-state-in-effect` (~18 файлов) — НЕ техдолг: это
осознанные паттерны (синхронизация с browser-API на маунте, debounce через
setTimeout, derived-state при смене маршрута с замером DOM), где правило даёт
ложное срабатывание. Не «чини» их заменой на useSyncExternalStore ради галочки.

## 11. Частые задачи — с чего начать

| Задача | Где смотреть |
|---|---|
| Новая возможность Admin AI | `lib/ai-console/run-assistant.ts` (+ `assistant.ts`, иконка в `ai-console.tsx`) |
| Изменить поведение продавца | директивы `lib/data/ai-directives.ts` или промпт `lib/ai/manager-brain.ts` |
| Изменить вход мозга (лимиты, RAG) | ТОЛЬКО `lib/ai/assemble-brain-input.ts` (см. раздел 6) |
| Подключение аккаунтов (server actions) | барель `app/actions/admin-accounts.ts` → telegram/bots/maintenance |
| Лид-карточки (слой данных) | барель `lib/data/lead-cards.ts` → queries/archive/upsert/lifecycle |
| Фоновый поллинг в UI | `lib/hooks/use-shared-poll.ts` — не пиши собственный setInterval |
| Новая настройка ИИ | колонка в `ai_assist_settings` (миграция) → `lib/data/ai-assist-settings.ts` → инструмент в co-pilot |
| Новый канал / воркер | `worker/src/*`, `lib/autopilot/*`, доставка — `lib/outbound-dispatch.ts` |
| БД-слой воркера | барели `worker/src/repo.ts` (jobs/channels/proxies/tg-cache) и `repo-ai.ts` (config/context/autopilot/logs) |
| Прочтение сообщений / unread | `messages.read_at` (миграция 125): штамп в `markConversationRead` и при ответе; пересчёт — COUNT непрочитанных входящих |
| Финансы (server actions) | барель `app/actions/finance.ts` → workspace/ads/vault |
| Редактор виджета | `components/admin/widget-editor/` (вкладка = файл, общее в shared.tsx) |
| Раздел «Все лиды» (админ) | контейнер `all-leads-section.tsx` + хук `components/admin/leads/use-leads-data.ts` |
| Карточка лида (куратор) | `lead-detail-panel.tsx` + подкомпоненты `components/curator/lead-detail/*` |
| Инбокс менеджера | `inbox-view.tsx` (верстка) + хук `components/manager/inbox/use-inbox.ts` |
| Автопилот (UI менеджера) | `autopilot-manager.tsx` + `components/manager/autopilot/*` |
| Расходы (финансы, админ) | `expenses-panel.tsx` + `components/admin/finance/expenses/*` |
| Общие TS-типы | `lib/types/*` (доменные модули), импорт через `@/lib/types` |
| Аналитика/отчёты | `lib/data/ai-analytics.ts`, `lib/ai/deal-heat.ts` |
| Дожим молчунов | `lib/followup/runtime.ts`, `lib/data/ai-followup.ts` |
| god-панель | `app/wijegniwjgwjog/`, `components/admin/secret-*`, `components/admin/god-messenger/` (см. раздел 3!) |
| Хостинг/деплой на серверы | `lib/data/hosting.ts`, `worker/src/hosting/*` (агент, SSH, safety) |
| ОС-шелл god-панели | `components/admin/os-shell/`, `lib/data/console-shell.ts` |
