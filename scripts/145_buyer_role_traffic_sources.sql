-- 145_buyer_role_traffic_sources.sql
--
-- Новая роль «медиабайер» (buyer): человек, который приводит трафик.
-- Живёт в той же таблице managers (общая auth/session-машинерия, как
-- curator в 111 и head в 141). Различие — role = 'buyer'.
--
-- Источники трафика (traffic_sources): каждый источник ведёт один байер,
-- к источнику подключаются менеджеры продаж (managers.traffic_source_id),
-- лиды наследуют источник от менеджера (lead_cards.traffic_source_id).
-- У источника своё дневное окно статистики: «день» = [day_start, day_end),
-- «долёты» = всё остальное время суток. Умолчания 09:00–18:00 / 18:00–09:00.

-- 1) Домен ролей: manager | curator | head | buyer -------------------------------
ALTER TABLE managers DROP CONSTRAINT IF EXISTS managers_role_check;
ALTER TABLE managers
  ADD CONSTRAINT managers_role_check
  CHECK (role IN ('manager', 'curator', 'head', 'buyer'));

-- Байер, как manager и head, без города. Город обязателен только у куратора.
ALTER TABLE managers DROP CONSTRAINT IF EXISTS managers_city_role_check;
ALTER TABLE managers
  ADD CONSTRAINT managers_city_role_check
  CHECK (
    (role = 'curator' AND city IS NOT NULL AND length(trim(city)) > 0)
    OR (role IN ('manager', 'head', 'buyer') AND city IS NULL)
  );

-- 2) Источники трафика ------------------------------------------------------------
-- day_start / day_end — минуты от полуночи МСК [0, 1440). Окно «дня»
-- полуоткрытое [day_start, day_end); «долёты» — дополнение до суток.
-- Ночное окно, переходящее через полночь, выражается парой day_start > day_end
-- не поддерживаем сознательно: «день» — всегда внутри одних суток.
CREATE TABLE IF NOT EXISTS traffic_sources (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL,
  -- Байер источника. SET NULL: удаление байера не сносит источник и данные.
  buyer_id   UUID REFERENCES managers (id) ON DELETE SET NULL,
  day_start  SMALLINT NOT NULL DEFAULT 540
             CHECK (day_start >= 0 AND day_start < 1440),
  day_end    SMALLINT NOT NULL DEFAULT 1080
             CHECK (day_end > 0 AND day_end <= 1440),
  notes      TEXT,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT traffic_sources_window_check CHECK (day_start < day_end)
);

CREATE INDEX IF NOT EXISTS idx_traffic_sources_buyer
  ON traffic_sources (buyer_id);

-- 3) Привязка менеджеров продаж к источнику ----------------------------------------
-- Менеджер подключён максимум к одному источнику и наследует его правила.
ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS traffic_source_id UUID
  REFERENCES traffic_sources (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_managers_traffic_source
  ON managers (traffic_source_id)
  WHERE traffic_source_id IS NOT NULL;

-- 4) Источник у лида ---------------------------------------------------------------
-- Денормализация сознательная: лид фиксирует источник НА МОМЕНТ обращения.
-- Последующий перенос менеджера между источниками историю не переписывает.
ALTER TABLE lead_cards
  ADD COLUMN IF NOT EXISTS traffic_source_id UUID
  REFERENCES traffic_sources (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lead_cards_traffic_source
  ON lead_cards (traffic_source_id)
  WHERE traffic_source_id IS NOT NULL;

-- Backfill: существующие лиды наследуют источник своего менеджера.
-- Сейчас traffic_source_id у всех менеджеров NULL (таблица только создана),
-- UPDATE ничего не тронет — но оставляем для повторных прогонов миграции
-- на базах, где привязки уже появились между деплоями.
UPDATE lead_cards lc
   SET traffic_source_id = m.traffic_source_id
  FROM managers m
 WHERE m.id = lc.manager_id
   AND lc.traffic_source_id IS NULL
   AND m.traffic_source_id IS NOT NULL;
