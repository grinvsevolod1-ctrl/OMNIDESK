-- Прямая интеграция рекламных кабинетов с Яндекс.Директом + ручные
-- корректировки метрик с «god»-страницы.
--
-- Модель:
--   finance_ad_accounts (существующая) получает поля интеграции:
--     external_enabled  — включена ли автосинхронизация с площадкой;
--     yandex_login      — Client-Login кабинета (для агентских токенов);
--     yandex_token_enc  — OAuth-токен, зашифрован AES-256-GCM (lib/crypto);
--     last_sync_at      — когда последний раз тянули данные;
--     sync_error        — текст последней ошибки синка ('' если ок).
--
--   finance_ad_sync_stats — «сырые» кумулятивные метрики из Яндекса
--     (одна строка на кабинет, перезаписывается при каждом синке).
--
--   finance_ad_overrides — ручные значения метрик с god-страницы.
--     value    — значение, которое зафиксировал админ («моя база»);
--     baseline — значение Яндекса на момент фиксации.
--   Итоговая метрика = value + max(0, yandex_текущий − baseline),
--   то есть новые данные Яндекса просто приплюсовываются к «моей базе».

-- 1) Поля интеграции на кабинете.
ALTER TABLE finance_ad_accounts
  ADD COLUMN IF NOT EXISTS external_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE finance_ad_accounts
  ADD COLUMN IF NOT EXISTS yandex_login text NOT NULL DEFAULT '';
ALTER TABLE finance_ad_accounts
  ADD COLUMN IF NOT EXISTS yandex_token_enc text;
ALTER TABLE finance_ad_accounts
  ADD COLUMN IF NOT EXISTS last_sync_at timestamptz;
ALTER TABLE finance_ad_accounts
  ADD COLUMN IF NOT EXISTS sync_error text NOT NULL DEFAULT '';

-- 2) Последний снимок метрик из Яндекса (кумулятивно за весь период).
CREATE TABLE IF NOT EXISTS finance_ad_sync_stats (
  account_id   uuid PRIMARY KEY
                 REFERENCES finance_ad_accounts(id) ON DELETE CASCADE,
  period_start date   NOT NULL DEFAULT CURRENT_DATE,
  period_end   date   NOT NULL DEFAULT CURRENT_DATE,
  impressions  bigint NOT NULL DEFAULT 0,
  clicks       bigint NOT NULL DEFAULT 0,
  leads        bigint NOT NULL DEFAULT 0,
  spend        numeric(14, 2) NOT NULL DEFAULT 0,
  synced_at    timestamptz NOT NULL DEFAULT now()
);

-- 3) Ручные корректировки метрик (god-страница).
--    metric ∈ 'impressions' | 'clicks' | 'leads' | 'spend'.
CREATE TABLE IF NOT EXISTS finance_ad_overrides (
  account_id uuid NOT NULL
               REFERENCES finance_ad_accounts(id) ON DELETE CASCADE,
  metric     text NOT NULL,
  value      numeric(16, 2) NOT NULL DEFAULT 0,
  baseline   numeric(16, 2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, metric)
);
