-- 170_realtime_lead_id_and_source.sql
--
-- Расширение realtime под точечные обновления и живые дашборды источников.
--
-- 1) notify_lead_card_change теперь несёт id карточки, чтобы ОТКРЫТАЯ карточка
--    лида обновлялась мгновенно, когда её меняет другой сотрудник (комментарий,
--    статус, передача). Списки по-прежнему делают полный refetch — им id не
--    нужен, но он безопасно добавляется в тот же лёгкий payload (лимит
--    pg_notify 8000 байт не задет: это один UUID).
--
-- 2) Новое событие type='source' с триггеров на traffic_sources,
--    source_spend_daily и source_deposits — обзор источников (админ/руководитель),
--    модал отчёта по источнику и финансовый раздел байера обновляются вживую,
--    когда байер вносит расход/решает по депозиту или меняется сам источник.
--    Payload минимальный (sourceId + buyerId): клиент перезапрашивает свои
--    данные через server actions с проверкой прав, патчить строку смысла нет.

-- 1) Лид-карточки: добавляем id в payload -------------------------------------
CREATE OR REPLACE FUNCTION notify_lead_card_change() RETURNS trigger AS $$
DECLARE
  rec RECORD;
BEGIN
  rec := COALESCE(NEW, OLD);
  PERFORM pg_notify('realtime', json_build_object(
    'type', 'lead',
    'id', rec.id,
    'managerId', rec.manager_id,
    'curatorId', rec.curator_id
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- 2) Источники трафика / расход / депозиты: событие 'source' -------------------
-- Единая функция для трёх таблиц. У traffic_sources сам row.id — это sourceId;
-- у source_spend_daily и source_deposits sourceId лежит в source_id. Разводим
-- через TG_TABLE_NAME, чтобы держать одну точку правды.
CREATE OR REPLACE FUNCTION notify_source_change() RETURNS trigger AS $$
DECLARE
  rec RECORD;
  sid UUID;
BEGIN
  rec := COALESCE(NEW, OLD);
  IF TG_TABLE_NAME = 'traffic_sources' THEN
    sid := rec.id;
  ELSE
    sid := rec.source_id;
  END IF;
  PERFORM pg_notify('realtime', json_build_object(
    'type', 'source',
    'sourceId', sid,
    'buyerId', rec.buyer_id
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_traffic_sources_notify ON traffic_sources;
CREATE TRIGGER trg_traffic_sources_notify
  AFTER INSERT OR UPDATE OR DELETE ON traffic_sources
  FOR EACH ROW EXECUTE FUNCTION notify_source_change();

DROP TRIGGER IF EXISTS trg_source_spend_daily_notify ON source_spend_daily;
CREATE TRIGGER trg_source_spend_daily_notify
  AFTER INSERT OR UPDATE OR DELETE ON source_spend_daily
  FOR EACH ROW EXECUTE FUNCTION notify_source_change();

DROP TRIGGER IF EXISTS trg_source_deposits_notify ON source_deposits;
CREATE TRIGGER trg_source_deposits_notify
  AFTER INSERT OR UPDATE OR DELETE ON source_deposits
  FOR EACH ROW EXECUTE FUNCTION notify_source_change();
