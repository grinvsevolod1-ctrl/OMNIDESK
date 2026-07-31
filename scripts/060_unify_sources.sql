-- Унификация «источников»: слияние source_groups (Обзор) и finance_resources
-- (Учёт) в ОДНУ сущность. Канонической записью становится finance_resources;
-- каналы привязываются к ней через новую таблицу source_channels.
--
-- Идемпотентно и безопасно для отката: старые таблицы source_groups /
-- source_group_channels НЕ удаляются — они остаются как резерв на случай
-- необходимости вернуться к прежней схеме.

-- 1) Новая связь «источник (finance_resource) ↔ канал».
--    channel_id уникален: один канал принадлежит максимум одному источнику
--    (та же семантика, что была у source_group_channels).
CREATE TABLE IF NOT EXISTS source_channels (
  resource_id uuid NOT NULL REFERENCES finance_resources(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_id, channel_id),
  UNIQUE (channel_id)
);

CREATE INDEX IF NOT EXISTS source_channels_resource_idx
  ON source_channels (resource_id);

-- 2) Бэкофилл: для каждой старой группы-источника гарантируем наличие
--    finance_resource с тем же именем (сопоставляем по имени без учёта регистра
--    и крайних пробелов; если совпадения нет — создаём новый ресурс).
DO $$
DECLARE
  g            RECORD;
  target_id    uuid;
BEGIN
  -- Пропускаем весь блок, если старой таблицы уже нет (чистая новая установка).
  IF to_regclass('public.source_groups') IS NULL THEN
    RETURN;
  END IF;

  FOR g IN SELECT id, name, created_at FROM source_groups LOOP
    -- Ищем существующий ресурс с таким же именем.
    SELECT id INTO target_id
      FROM finance_resources
     WHERE lower(btrim(name)) = lower(btrim(g.name))
     ORDER BY created_at ASC
     LIMIT 1;

    -- Нет — создаём новый источник в Учёте под этим именем.
    IF target_id IS NULL THEN
      INSERT INTO finance_resources (name, description, currency, created_at)
      VALUES (btrim(g.name), '', 'USDT', g.created_at)
      RETURNING id INTO target_id;
    END IF;

    -- Переносим каналы группы в source_channels на найденный/созданный ресурс.
    -- ON CONFLICT по channel_id: последняя привязка выигрывает (как раньше).
    IF to_regclass('public.source_group_channels') IS NOT NULL THEN
      INSERT INTO source_channels (resource_id, channel_id)
      SELECT target_id, sgc.channel_id
        FROM source_group_channels sgc
       WHERE sgc.group_id = g.id
      ON CONFLICT (channel_id)
        DO UPDATE SET resource_id = EXCLUDED.resource_id;
    END IF;
  END LOOP;
END $$;
