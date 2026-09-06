-- Финансы и учёт источников трафика байера.
--
-- Расширяем traffic_sources до полноценной сущности, которую создаёт и ведёт
-- БАЙЕР (а не админ). Источник = единый источник правды: на него уже ссылаются
-- managers.traffic_source_id и lead_cards.traffic_source_id (миграция 145).
--
-- Финансовая модель (референс — старая admin-only finance_ad_*, но привязка к
-- байеру и его источникам, а не к «ресурсам»/god-симуляции):
--   Источник трафика (traffic_sources)  [платформа + своя валюта]
--     ├── Депозиты (source_deposits)      админ/head → байер (+ к балансу)
--     └── Дневной лог трат (source_spend_daily)  байер (− из баланса, + метрики)
--
--   Баланс источника = Σ(подтверждённых депозитов) − Σ(трат).
--   Мультивалюта: суммы приводятся к базовой RUB через FX-заморозку курса
--   (orig_amount / orig_currency / fx_rate), как в finance_entries (059).

-- 1) Расширяем traffic_sources. Всё аддитивно, старые строки получают дефолты.
ALTER TABLE traffic_sources
  -- Ключ платформы из каталога: 'yandex_direct' | 'google_ads' | 'vk_ads' |
  -- 'telegram_ads' | 'mytarget' | 'meta_ads' | 'tiktok_ads' | 'avito' |
  -- 'ok_ads' | 'custom' | ...
  ADD COLUMN IF NOT EXISTS platform_key     text NOT NULL DEFAULT 'custom',
  -- Базовая валюта учёта источника (в ней показывается баланс).
  ADD COLUMN IF NOT EXISTS currency         text NOT NULL DEFAULT 'RUB',
  -- Логин / номер кабинета / ссылка на кабинет площадки.
  ADD COLUMN IF NOT EXISTS external_account text NOT NULL DEFAULT '',
  -- Произвольная конфигурация каталога/платформы (jsonb).
  ADD COLUMN IF NOT EXISTS config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Байер завершил первичную настройку источника (мастер каталога).
  ADD COLUMN IF NOT EXISTS setup_completed  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- 2) Депозиты (бюджеты): вносит админ/head, байер подтверждает или отклоняет.
CREATE TABLE IF NOT EXISTS source_deposits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES traffic_sources(id) ON DELETE CASCADE,
  -- Байер-владелец источника на момент депозита (денормализация для скоупа).
  buyer_id        uuid REFERENCES managers(id) ON DELETE SET NULL,
  -- Кто внёс депозит (admin: NULL manager, отмечаем в created_by_kind; head: id).
  created_by       uuid REFERENCES managers(id) ON DELETE SET NULL,
  created_by_kind  text NOT NULL DEFAULT 'admin', -- 'admin' | 'head'
  -- Сумма в базовой валюте источника (RUB), уже сконвертирована.
  amount           numeric(14, 2) NOT NULL DEFAULT 0,
  -- FX-заморозка: сумма и валюта ввода + курс к базовой на момент внесения.
  orig_amount      numeric(14, 2) NOT NULL DEFAULT 0,
  orig_currency    text NOT NULL DEFAULT 'RUB',
  fx_rate          numeric(18, 8) NOT NULL DEFAULT 1,
  -- Назначение бюджета (куда и на что) — заполняет автор.
  purpose          text NOT NULL DEFAULT '',
  -- 'pending' | 'confirmed' | 'rejected'
  status           text NOT NULL DEFAULT 'pending',
  -- Причина отклонения / отчётный комментарий байера.
  buyer_note       text NOT NULL DEFAULT '',
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_deposits_status_check
    CHECK (status IN ('pending', 'confirmed', 'rejected')),
  CONSTRAINT source_deposits_kind_check
    CHECK (created_by_kind IN ('admin', 'head'))
);

CREATE INDEX IF NOT EXISTS source_deposits_source_idx
  ON source_deposits (source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS source_deposits_buyer_idx
  ON source_deposits (buyer_id, status, created_at DESC);

-- 3) Дневной лог трат байера: одна строка на источник и день (upsert).
CREATE TABLE IF NOT EXISTS source_spend_daily (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid NOT NULL REFERENCES traffic_sources(id) ON DELETE CASCADE,
  buyer_id      uuid REFERENCES managers(id) ON DELETE SET NULL,
  spend_date    date NOT NULL DEFAULT CURRENT_DATE,
  -- Расход в базовой валюте источника (RUB).
  spend         numeric(14, 2) NOT NULL DEFAULT 0,
  impressions   bigint NOT NULL DEFAULT 0,
  clicks        bigint NOT NULL DEFAULT 0,
  leads         bigint NOT NULL DEFAULT 0,
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Один день = одна строка на источник (upsert по (source_id, spend_date)).
  CONSTRAINT source_spend_daily_uniq UNIQUE (source_id, spend_date)
);

CREATE INDEX IF NOT EXISTS source_spend_daily_source_idx
  ON source_spend_daily (source_id, spend_date DESC);

-- 4) Закрепление байеров за руководителем идёт через СУЩЕСТВУЮЩУЮ модель команд
--    (миграция 150): teams.head_id + managers.team_id. Роль 'buyer' уже валидна
--    для managers.team_id (FK + role-check это допускают), поэтому отдельная
--    join-таблица не нужна — иначе мы бы завели третий параллельный механизм
--    ровно того типа, который миграция 150 намеренно устранила (она дропнула
--    head_curators / head_managers ради единого источника правды). Индекс по
--    (role, team_id) для быстрого скоупа байеров команды.
CREATE INDEX IF NOT EXISTS managers_buyer_team_idx
  ON managers (team_id) WHERE role = 'buyer';

-- 5) Бэкофилл: setup_completed = true существующим непустым источникам, чтобы они
--    не висели «в настройке» после расширения схемы. Депозитов/трат ещё нет,
--    их бэкофилл не требуется; владелец-байер источника — traffic_sources.buyer_id.
UPDATE traffic_sources
   SET setup_completed = true
 WHERE setup_completed = false
   AND coalesce(name, '') <> '';
