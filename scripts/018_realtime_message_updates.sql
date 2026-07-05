-- Omnidesk realtime migration (run after 017_message_actions.sql).
-- Extends the shared 'realtime' NOTIFY so message UPDATES (reactions, soft
-- deletes) fan out to every connected panel/widget — previously only message
-- INSERTs fired, so reactions/deletions were invisible to other tabs/devices
-- until a manual reload.
--
-- Safe to run multiple times (CREATE OR REPLACE + idempotent triggers).

CREATE OR REPLACE FUNCTION notify_realtime() RETURNS trigger AS $$
DECLARE
  payload json;
  conv    record;
BEGIN
  IF (TG_TABLE_NAME = 'messages') THEN
    SELECT c.manager_id, c.channel_id, c.channel_type, c.contact_handle
      INTO conv
      FROM conversations c
     WHERE c.id = NEW.conversation_id;

    IF (TG_OP = 'UPDATE') THEN
      -- Lightweight "message changed in place" event. Carries just enough for
      -- subscribers to patch the affected message locally (no full refetch).
      payload := json_build_object(
        'type', 'message',
        'event', 'update',
        'managerId', conv.manager_id,
        'channelId', conv.channel_id,
        'channelType', conv.channel_type,
        'conversationId', NEW.conversation_id,
        'contactHandle', conv.contact_handle,
        'id', NEW.id,
        'direction', NEW.direction,
        'body', NEW.body,
        'reactions', NEW.reactions,
        'deletedAt', NEW.deleted_at
      );
    ELSE
      payload := json_build_object(
        'type', 'message',
        'event', 'insert',
        'managerId', conv.manager_id,
        'channelId', conv.channel_id,
        'channelType', conv.channel_type,
        'conversationId', NEW.conversation_id,
        'contactHandle', conv.contact_handle,
        'id', NEW.id,
        'direction', NEW.direction,
        'body', NEW.body,
        'author', NEW.author,
        'createdAt', NEW.created_at
      );
    END IF;

  ELSIF (TG_TABLE_NAME = 'conversations') THEN
    payload := json_build_object(
      'type', 'conversation',
      'managerId', NEW.manager_id,
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

  PERFORM pg_notify('realtime', payload::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- INSERT trigger (re-asserted, unchanged behaviour).
DROP TRIGGER IF EXISTS trg_realtime_messages ON messages;
CREATE TRIGGER trg_realtime_messages
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_realtime();

-- UPDATE trigger: fire ONLY when a user-visible field changed (reactions /
-- soft-delete / body). This deliberately skips provider_message_id backfills
-- so the worker writing the Telegram id doesn't cause needless UI refreshes.
DROP TRIGGER IF EXISTS trg_realtime_messages_upd ON messages;
CREATE TRIGGER trg_realtime_messages_upd
  AFTER UPDATE ON messages
  FOR EACH ROW
  WHEN (
    OLD.reactions IS DISTINCT FROM NEW.reactions
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.body IS DISTINCT FROM NEW.body
  )
  EXECUTE FUNCTION notify_realtime();
