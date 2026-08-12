-- 127_lead_cards_realtime.sql
--
-- Realtime для лид-карточек: триггер шлёт лёгкое событие в общий канал
-- 'realtime' (тот же, что для сообщений/диалогов — см. 003/004), чтобы
-- вьюхи лидов обновлялись мгновенно по SSE вместо частого поллинга.
--
-- Payload НАМЕРЕННО минимальный (type + адресаты): pg_notify имеет жёсткий
-- лимит 8000 байт (см. 023), а клиенту всё равно нужен полный refetch —
-- фильтры/пагинация живут на клиенте, патчить одну карточку бессмысленно.

CREATE OR REPLACE FUNCTION notify_lead_card_change() RETURNS trigger AS $$
DECLARE
  rec RECORD;
BEGIN
  rec := COALESCE(NEW, OLD);
  PERFORM pg_notify('realtime', json_build_object(
    'type', 'lead',
    'managerId', rec.manager_id,
    'curatorId', rec.curator_id
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_cards_notify ON lead_cards;
CREATE TRIGGER trg_lead_cards_notify
  AFTER INSERT OR UPDATE OR DELETE ON lead_cards
  FOR EACH ROW EXECUTE FUNCTION notify_lead_card_change();
