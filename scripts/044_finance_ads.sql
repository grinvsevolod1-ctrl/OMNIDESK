-- Учёт: рекламные кабинеты + обогащение расходов.
--
-- Доходов у бизнеса нет — вместо них ключевые метрики: ЛИДЫ и расход на рекламу.
-- Модель рекламы:
--   Ресурс (site.com)
--     └── Рекламный кабинет (Яндекс Директ, Google Ads, VK…)  [своя валюта]
--           ├── Пополнения баланса  (+ к балансу)
--           └── Снимки статистики    (расход − к балансу, + показы/клики/лиды)
--
-- Баланс кабинета = Σ(пополнения) − Σ(расход из статистики).
-- Всё admin-only (страница /admin/finance закрыта requireAdmin()).

-- 1) Рекламные кабинеты внутри ресурса.
CREATE TABLE IF NOT EXISTS finance_ad_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES finance_resources(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- 'yandex_direct' | 'google_ads' | 'vk_ads' | 'telegram_ads' | 'mytarget' | 'other'
  platform    text NOT NULL DEFAULT 'yandex_direct',
  -- 'active' | 'moderation' | 'stopped' | 'no_funds' | 'banned' | 'archived'
  status      text NOT NULL DEFAULT 'active',
  -- Логин / номер кабинета / идентификатор.
  account_ref text NOT NULL DEFAULT '',
  -- Своя валюта у каждого кабинета (RUB у Яндекса, USD у Google и т.д.).
  currency    text NOT NULL DEFAULT 'RUB',
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_ad_accounts_resource_idx
  ON finance_ad_accounts (resource_id, created_at);

-- 2) Пополнения баланса кабинета (плюсуют баланс).
CREATE TABLE IF NOT EXISTS finance_ad_topups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES finance_ad_accounts(id) ON DELETE CASCADE,
  amount     numeric(14, 2) NOT NULL DEFAULT 0,
  topup_date date NOT NULL DEFAULT CURRENT_DATE,
  note       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_ad_topups_account_idx
  ON finance_ad_topups (account_id, topup_date DESC, created_at DESC);

-- 3) Снимки статистики за период (расход минусует баланс, даёт метрики).
CREATE TABLE IF NOT EXISTS finance_ad_stats (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES finance_ad_accounts(id) ON DELETE CASCADE,
  period_start date NOT NULL DEFAULT CURRENT_DATE,
  period_end   date NOT NULL DEFAULT CURRENT_DATE,
  impressions  bigint NOT NULL DEFAULT 0,
  clicks       bigint NOT NULL DEFAULT 0,
  leads        bigint NOT NULL DEFAULT 0,
  spend        numeric(14, 2) NOT NULL DEFAULT 0,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_ad_stats_account_idx
  ON finance_ad_stats (account_id, period_start DESC, created_at DESC);

-- 4) Обогащение расходов: контрагент и срок оплаты.
ALTER TABLE finance_entries
  ADD COLUMN IF NOT EXISTS vendor text NOT NULL DEFAULT '';
ALTER TABLE finance_entries
  ADD COLUMN IF NOT EXISTS due_date date;
