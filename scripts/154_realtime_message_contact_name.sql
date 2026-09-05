-- Omnidesk migration 154: include the contact's display NAME in the realtime
-- message payload.
--
-- Web-push notifications built the title from `contactName || contactHandle`
-- (see lib/push-dispatcher.ts), but the `messages` NOTIFY payload only ever
-- carried `contactHandle` — so every push showed the raw @username / numeric id
-- instead of the person's name. Add `contactName` (the conversation's
-- contact_name) to both message branches so notifications read like "Иван
-- Петров · Telegram" instead of "389373782 · Telegram".
--
-- Based on the notify_realtime() definition from migration 151. Safe to run
-- multiple times (CREATE OR REPLACE); triggers reference the function by name,
-- so replacing the body updates them in place — no trigger recreation needed.

CREATE OR REPLACE FUNCTION notify_realtime() RETURNS trigger AS $$
DECLARE
  payload json;
  conv    record;
BEGIN
  IF (TG_TABLE_NAME = 'messages') THEN
    SELECT c.manager_id, c.curator_id, c.channel_id, c.channel_type,
           c.contact_handle, c.contact_name
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
        'contactName', conv.contact_name,
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
        'contactName', conv.contact_name,
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
