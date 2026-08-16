-- Telegram message actions: reply, reactions, soft-delete.
--
-- Builds on the existing messages.provider_message_id column (already used for
-- WhatsApp de-dup and Telegram media re-fetch). For Telegram we now also store
-- provider_message_id for EVERY message (inbound + outbound) so the worker can
-- reply to / react to / delete / forward a specific message by its Telegram id.
--
-- Safe to run multiple times.

-- Quoted-reply link to another row in the same table. ON DELETE SET NULL so
-- removing the quoted message doesn't cascade-delete the reply.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid
    REFERENCES messages(id) ON DELETE SET NULL;

-- Reactions as a small JSON array: [{ "emoji": "👍", "fromMe": true }, ...].
-- We mainly track the operator's own reaction, but the shape allows showing the
-- contact's reactions too when the worker reports them.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reactions jsonb;

-- Soft-delete marker. When set, the thread renders a "message deleted"
-- placeholder instead of dropping the row (keeps reply references intact).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Lookups by reply target when hydrating quote previews.
CREATE INDEX IF NOT EXISTS idx_messages_reply_to
  ON messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
