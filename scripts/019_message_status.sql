-- Omnidesk delivery/read status migration (run after 018_realtime_message_updates.sql).
--
-- Adds a per-message delivery lifecycle for OUTBOUND messages so the panel can
-- show whether a message we sent was delivered to and read by the contact —
-- mirroring the WhatsApp/Telegram "single check / double check / blue check"
-- semantics.
--
--   sent      -> accepted by the provider (left our side)            [✓]
--   delivered -> reached the contact's device                        [✓✓ grey]
--   read      -> the contact opened/read it                          [✓✓ blue]
--   failed    -> the provider rejected it (e.g. WhatsApp 463, not on WA) [!]
--
-- Inbound messages keep status = NULL (not applicable). The status only ever
-- moves FORWARD (sent -> delivered -> read); see worker repo.setMessageStatus.
--
-- Safe to run multiple times.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS status text
    CHECK (status IS NULL OR status IN ('sent', 'delivered', 'read', 'failed'));

-- Existing outbound rows are assumed delivered-or-better historically; leave
-- them NULL so the UI simply shows the old single tick until new sends populate
-- a real status. New outbound messages default to 'sent' at insert time.

-- Extend the realtime fan-out so a status change pushes an in-place message
-- update to every connected panel (no full refetch). This re-asserts the
-- function from 018 with `status` added to the UPDATE payload.
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
        'deletedAt', NEW.deleted_at,
        'status', NEW.status
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
        'createdAt', NEW.created_at,
        'status', NEW.status
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

-- Re-assert the UPDATE trigger so a status change also fans out. (Adding
-- status to the WHEN predicate; reactions/deletes/body still fire as before.)
DROP TRIGGER IF EXISTS trg_realtime_messages_upd ON messages;
CREATE TRIGGER trg_realtime_messages_upd
  AFTER UPDATE ON messages
  FOR EACH ROW
  WHEN (
    OLD.reactions IS DISTINCT FROM NEW.reactions
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.status IS DISTINCT FROM NEW.status
  )
  EXECUTE FUNCTION notify_realtime();
