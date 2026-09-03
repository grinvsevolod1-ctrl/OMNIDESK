-- Omnidesk migration 151: раздел «Чаты» у кураторов (переданные лиды).
--
-- Когда лид передаётся куратору (прямая передача менеджером или захват из пула/
-- команды), диалог должен появиться в разделе «Чаты» этого куратора. При этом
-- диалог остаётся привязан к менеджеру (conversations.manager_id не трогаем —
-- владение сообщениями и очередь отправки завязаны на него), а куратор получает
-- ПАРАЛЛЕЛЬНУЮ ссылку через новую колонку conversations.curator_id. Менеджер
-- продолжает видеть диалог, но только для чтения; ИИ менеджера перестаёт вести
-- переданный диалог (гейт curator_id IS NULL в isConversationAiLed).
--
-- Изменения:
--   1. conversations.curator_id — куратор, которому передан диалог (NULL = не
--      передан). ON DELETE SET NULL: удаление аккаунта куратора не рушит диалог.
--   2. conversations.transferred_to_curator_at — момент передачи (бейдж/сортировка).
--   3. Частичный индекс по curator_id — быстрый список «Чаты» куратора.
--   4. notify_realtime() переассертим (актуальная версия из 040) + добавляем
--      curatorId во ВСЕ payload'ы (message insert/update и conversation), чтобы
--      SSE доставлял события куратору так же, как менеджеру. Приём тот же, что
--      уже используется для lead-событий (curatorId, миграция 127).
--
-- Идемпотентно. Запуск на VPS:
--   psql "$DATABASE_URL" -f scripts/151_curator_conversations.sql

-- 1. Ссылка на куратора ------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS curator_id uuid REFERENCES managers(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS transferred_to_curator_at timestamptz;

-- 2. Индекс для списка диалогов куратора -------------------------------------
CREATE INDEX IF NOT EXISTS idx_conversations_curator
  ON conversations (curator_id)
  WHERE curator_id IS NOT NULL;

-- 3. Реалтайм: несём curatorId во всех событиях ------------------------------
-- Переассерт актуальной функции из 040_proxy_and_errors.sql с добавленным
-- curatorId. Всё остальное (error_reason, status, guard 7800 байт) сохранено
-- байт-в-байт, чтобы не потерять предыдущие поля.
CREATE OR REPLACE FUNCTION notify_realtime() RETURNS trigger AS $$
DECLARE
  payload json;
  conv    record;
BEGIN
  IF (TG_TABLE_NAME = 'messages') THEN
    SELECT c.manager_id, c.curator_id, c.channel_id, c.channel_type, c.contact_handle
      INTO conv
      FROM conversations c
     WHERE c.id = NEW.conversation_id;

    IF (TG_OP = 'UPDATE') THEN
      payload := json_build_object(
        'type', 'message',
        'event', 'update',
        'managerId', conv.manager_id,
        'curatorId', conv.curator_id,
        'channelId', conv.channel_id,
        'channelType', conv.channel_type,
        'conversationId', NEW.conversation_id,
        'contactHandle', conv.contact_handle,
        'id', NEW.id,
        'direction', NEW.direction,
        'body', NEW.body,
        'reactions', NEW.reactions,
        'deletedAt', NEW.deleted_at,
        'deletedOrigin', NEW.deleted_origin,
        'status', NEW.status,
        'errorReason', NEW.error_reason
      );
    ELSE
      payload := json_build_object(
        'type', 'message',
        'event', 'insert',
        'managerId', conv.manager_id,
        'curatorId', conv.curator_id,
        'channelId', conv.channel_id,
        'channelType', conv.channel_type,
        'conversationId', NEW.conversation_id,
        'contactHandle', conv.contact_handle,
        'id', NEW.id,
        'direction', NEW.direction,
        'body', NEW.body,
        'author', NEW.author,
        'createdAt', NEW.created_at,
        'status', NEW.status,
        'errorReason', NEW.error_reason
      );
    END IF;

  ELSIF (TG_TABLE_NAME = 'conversations') THEN
    payload := json_build_object(
      'type', 'conversation',
      'managerId', NEW.manager_id,
      'curatorId', NEW.curator_id,
      'channelId', NEW.channel_id,
      'channelType', NEW.channel_type,
      'id', NEW.id,
      'contactHandle', NEW.contact_handle,
      'contactName', NEW.contact_name,
      'lastMessage', NEW.last_message,
      'unread', NEW.unread
    );

  ELSIF (TG_TABLE_NAME = 'channels') THEN
    payload := json_build_object(
      'type', 'channel',
      'managerId', NEW.manager_id,
      'id', NEW.id,
      'status', NEW.status,
      'sessionStatus', NEW.session_status
    );
  END IF;

  -- pg_notify caps payloads at 8000 bytes; strip bulky text if needed.
  IF octet_length(payload::text) > 7800 THEN
    payload := (
      payload::jsonb - 'body' - 'lastMessage'
      || '{"truncated": true}'::jsonb
    )::json;
  END IF;

  PERFORM pg_notify('realtime', payload::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Re-assert the UPDATE trigger (unchanged from 040) so the refreshed function
-- is used; a curator_id change on the conversation fans out via the existing
-- conversations trigger.
DROP TRIGGER IF EXISTS trg_realtime_messages_upd ON messages;
CREATE TRIGGER trg_realtime_messages_upd
  AFTER UPDATE ON messages
  FOR EACH ROW
  WHEN (
    OLD.reactions IS DISTINCT FROM NEW.reactions
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.deleted_origin IS DISTINCT FROM NEW.deleted_origin
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.error_reason IS DISTINCT FROM NEW.error_reason
  )
  EXECUTE FUNCTION notify_realtime();
