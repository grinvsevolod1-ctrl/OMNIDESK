-- Omnidesk migration 033: preserve deleted messages (run after 032_max_channel.sql).
--
-- Previously a soft-deleted message blanked its body and rendered as a neutral
-- "message deleted" placeholder, and deletions made by the CONTACT (the other
-- side) weren't captured at all. Operators want the opposite: when a message is
-- deleted — by us OR by the contact — we KEEP the original content and just
-- flag it as deleted, so nothing is ever lost.
--
-- This migration:
--   1. Adds `deleted_origin` so the UI can label WHO deleted the message
--      ('self' = the operator deleted it, 'remote' = the contact deleted it).
--   2. Re-asserts notify_realtime() (from 023) with `deletedOrigin` added to the
--      UPDATE payload so the marker propagates live to every connected panel.
--   3. Widens the UPDATE trigger predicate so an origin-only change still fans
--      out.
--
-- Note: the data layer no longer blanks the body on delete (see
-- lib.data.markMessageDeleted), so existing rows already blanked stay blank
-- (content was lost at delete time) while all future deletes retain content.
--
-- Safe to run multiple times.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_origin text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_messages_deleted_origin'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT chk_messages_deleted_origin
      CHECK (deleted_origin IS NULL OR deleted_origin IN ('self', 'remote'));
  END IF;
END $$;

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
        'deletedOrigin', NEW.deleted_origin,
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

  -- Safety guard (from 023): pg_notify caps payloads at 8000 bytes. Strip the
  -- bulky text fields if we'd exceed a safe ceiling, marking the event
  -- truncated so subscribers refetch. No-op when keys are absent.
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

-- Re-assert the UPDATE trigger; an origin-only change now also fans out.
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
  )
  EXECUTE FUNCTION notify_realtime();
