-- Omnidesk realtime migration (run after 003_engine.sql).
-- Enriches the 'realtime' NOTIFY payload so a single shared LISTEN connection
-- can fan out fully-formed events to both the manager panel (SSE) and the
-- public live-chat widget (SSE) without any extra per-event DB round-trips.
--
-- Safe to run multiple times (CREATE OR REPLACE + idempotent triggers).

/* ------------------------- realtime: enriched payload ------------------- */
-- Channel 'realtime' carries one JSON object per event. Common shape:
--   { type, managerId, ... }
-- Messages additionally carry direction/body/author and the parent
-- conversation's channelId / channelType / contactHandle so subscribers can
-- route to the right manager AND the right live-chat visitor.

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

    payload := json_build_object(
      'type', 'message',
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

-- Re-assert the triggers so a fresh DB that only ran 004 still works, and so
-- conversations fire on INSERT *and* UPDATE (new visitor + new reply).
DROP TRIGGER IF EXISTS trg_realtime_messages ON messages;
CREATE TRIGGER trg_realtime_messages
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_realtime();

DROP TRIGGER IF EXISTS trg_realtime_conversations ON conversations;
CREATE TRIGGER trg_realtime_conversations
  AFTER INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_realtime();

DROP TRIGGER IF EXISTS trg_realtime_channels ON channels;
CREATE TRIGGER trg_realtime_channels
  AFTER UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION notify_realtime();

/* --------------------------- live-chat lookups -------------------------- */
-- The widget authenticates with the channel's API key stored in config->>'apiKey'.
-- This partial index keeps that lookup fast.
CREATE INDEX IF NOT EXISTS idx_channels_livechat_apikey
  ON channels ((config ->> 'apiKey'))
  WHERE type = 'livechat';

-- Look up a conversation by channel + visitor handle (widget reconnect path).
CREATE INDEX IF NOT EXISTS idx_conversations_channel_handle
  ON conversations (channel_id, contact_handle);
