-- 169 — Источник трафика фиксируется на ДИАЛОГЕ в момент обращения.
--
-- Контекст: у диалога не было своей ссылки на источник — атрибуция «кто написал»
-- в отчёте источника (модалка «Обзора» админа/руководителя) шла через ТЕКУЩЕГО
-- менеджера диалога (conversations.manager_id → managers.traffic_source_id).
-- Из-за этого перевод менеджера в другой источник ЗАДНИМ ЧИСЛОМ переписывал
-- историю: его старые диалоги «переезжали» в новый источник.
--
-- Решение (тот же приём осознанной денормализации, что у лид-карточек в
-- миграции 145): диалог получает собственный traffic_source_id, зафиксированный
-- в момент СОЗДАНИЯ. Перевод менеджера больше историю не трогает.
--
--   1) колонка + индекс;
--   2) бэкофилл существующих диалогов снимком текущей привязки менеджера;
--   3) триггер BEFORE INSERT — застолбить источник из менеджера на ЛЮБОМ пути
--      создания диалога (воркер, inbound, livechat, admin-secret) без правки
--      прикладного кода.
-- Все шаги идемпотентны — повторный прогон безопасен.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS traffic_source_id uuid
    REFERENCES traffic_sources(id) ON DELETE SET NULL;

-- Отчёт фильтрует диалоги по источнику — частичный индекс покрывает выборку.
CREATE INDEX IF NOT EXISTS idx_conversations_traffic_source
  ON conversations (traffic_source_id)
  WHERE traffic_source_id IS NOT NULL;

-- Бэкофилл: замораживаем сегодняшнюю привязку для уже существующих диалогов.
UPDATE conversations c
   SET traffic_source_id = m.traffic_source_id
  FROM managers m
 WHERE m.id = c.manager_id
   AND c.traffic_source_id IS NULL
   AND m.traffic_source_id IS NOT NULL;

-- Триггер: при создании диалога, если источник не передан явно, наследуем его
-- от назначенного менеджера. Только BEFORE INSERT — перевод менеджера позже
-- источник диалога уже не меняет (ровно та стабильность, ради которой всё это).
CREATE OR REPLACE FUNCTION conversations_stamp_traffic_source()
RETURNS trigger AS $$
BEGIN
  IF NEW.traffic_source_id IS NULL AND NEW.manager_id IS NOT NULL THEN
    SELECT traffic_source_id INTO NEW.traffic_source_id
      FROM managers WHERE id = NEW.manager_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversations_stamp_traffic_source ON conversations;
CREATE TRIGGER trg_conversations_stamp_traffic_source
  BEFORE INSERT ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION conversations_stamp_traffic_source();
