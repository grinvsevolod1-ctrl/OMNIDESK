-- Omnidesk migration 040: mandatory-proxy uniqueness + delivery failure reasons.
--
-- Two related changes that back the "admin owns accounts, every account needs a
-- proxy, and managers must see WHY a send failed" rework:
--
--  1. messages.error_reason — a short, human-readable explanation attached to a
--     message whose delivery failed (status='failed'). Populated by the send
--     paths (VK / MAX / WhatsApp Cloud / Telegram worker) with a mapped,
--     end-user-friendly string (e.g. "Пользователь запретил сообщения от
--     сообщества" for VK error 901). Shown in the inbox next to the "!" marker.
--
--  2. uq_channels_proxy_type — enforces the proxy allocation rule: one proxy may
--     serve AT MOST ONE account of each type. So a single proxy can back one
--     Telegram + one WhatsApp + one VK + one MAX account (different types share
--     fine), but never two accounts of the SAME type. Two Telegram accounts
--     therefore require two different proxies. NULL proxy_id rows are excluded
--     (legacy accounts stay valid; the app layer requires a proxy on new
--     create/reassign).
--
-- Proxy is NOT made NOT NULL at the DB level on purpose: historical rows may
-- lack one and we don't want the migration to fail. The server actions enforce
-- "proxy required" for all new accounts and reassignments.
--
-- Also re-asserts notify_realtime() (from 023_realtime_payload_guard.sql) with
-- error_reason added to the message payloads, so a failed send fans out its
-- reason to every connected panel without a refetch.
--
-- Safe to run multiple times (idempotent).
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/040_proxy_and_errors.sql

-- 1. Failure reason column ---------------------------------------------------
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_reason text;

-- 2. Proxy allocation uniqueness (1 proxy = at most 1 account per type) -------
-- Partial unique index: only constrains rows that actually reference a proxy.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channels_proxy_type
  ON channels (proxy_id, type)
  WHERE proxy_id IS NOT NULL;

-- 3. Realtime fan-out: carry error_reason on message events ------------------
-- Re-asserts the guarded function from 023 with error_reason added to both the
-- INSERT and UPDATE message payloads. The 8000-byte pg_notify guard is kept.
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
        'status', NEW.status,
        'errorReason', NEW.error_reason
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
        'status', NEW.status,
        'errorReason', NEW.error_reason
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

-- Re-assert the UPDATE trigger so an error_reason change also fans out.
DROP TRIGGER IF EXISTS trg_realtime_messages_upd ON messages;
CREATE TRIGGER trg_realtime_messages_upd
  AFTER UPDATE ON messages
  FOR EACH ROW
  WHEN (
    OLD.reactions IS DISTINCT FROM NEW.reactions
    OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    OR OLD.body IS DISTINCT FROM NEW.body
    OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.error_reason IS DISTINCT FROM NEW.error_reason
  )
  EXECUTE FUNCTION notify_realtime();
