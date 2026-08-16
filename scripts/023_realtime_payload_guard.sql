-- Omnidesk migration 023: bound the realtime NOTIFY payload size.
--
-- ROOT CAUSE of "A server error occurred" when switching a lead's status (and,
-- more generally, when ANY conversation with a very long last message is
-- updated):
--
--   Postgres `pg_notify` has a HARD limit of 8000 bytes per payload. The
--   conversations payload embeds `last_message`, and the messages payload
--   embeds `body` — both unbounded user text. A long enough message pushes the
--   JSON over 8000 bytes, `pg_notify` raises, the triggering UPDATE/INSERT is
--   aborted, and the server action that issued the write throws. Short
--   conversations work, long ones crash — exactly the reported symptom.
--
-- FIX: keep the full text in the common case (so the live-chat widget still
-- receives complete agent replies), but add a safety guard right before the
-- notify: if the serialised payload would exceed a safe ceiling, drop the bulky
-- text fields (`body` / `lastMessage`) and flag the event as `truncated`. The
-- remaining fields are all bounded (ids, handles, names, counters), so the
-- notify can never exceed the limit again. Subscribers already refetch on these
-- events (the panel via router.refresh, the widget via history replay), so no
-- information is lost — only an oversized inline copy is omitted.
--
-- Re-asserts the function from 019_message_status.sql with the guard added.
-- Safe to run multiple times (CREATE OR REPLACE).
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/023_realtime_payload_guard.sql

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

  -- Safety guard: pg_notify caps payloads at 8000 bytes. If the serialised
  -- event would exceed a safe ceiling (long body / last_message, possibly with
  -- multi-byte UTF-8), strip the bulky text fields and mark it truncated so the
  -- write never aborts. `jsonb - key` is a no-op when the key is absent, so this
  -- is safe for every branch above.
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
