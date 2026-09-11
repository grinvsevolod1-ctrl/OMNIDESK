-- 172: массовая рассылка — группировка кампаний одного запуска.
--
-- batch_id связывает по одной кампании на каждый выбранный аккаунт в единый
-- «массовый запуск»: общий список групп, но у каждого аккаунта СВОЙ текст и
-- своя кампания. Раннер (worker/src/broadcast-runner.ts) тикает по кампаниям
-- независимо → аккаунты рассылают параллельно, каждый со своим пейсингом.
--
-- Колонка nullable: одиночная рассылка из карточки аккаунта batch_id не имеет.
-- Частичный индекс — только для сгруппированных кампаний (быстрый сбор пачки
-- в getMassBroadcastViewAction без сканирования одиночных).

ALTER TABLE broadcast_campaigns
  ADD COLUMN IF NOT EXISTS batch_id uuid;

CREATE INDEX IF NOT EXISTS broadcast_campaigns_batch_idx
  ON broadcast_campaigns (batch_id)
  WHERE batch_id IS NOT NULL;
