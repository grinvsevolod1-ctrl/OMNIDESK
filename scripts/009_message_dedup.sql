-- Omnidesk message dedup + history-import migration (run after 004_realtime.sql).
--
-- WhatsApp (and any provider that replays history on reconnect) can deliver the
-- same message more than once: once live via `messages.upsert`, again via
-- `messaging-history.set`, and again after every relink. Without a stable
-- provider-side id we get duplicate rows in the thread.
--
-- This adds an OPTIONAL provider message id and a PARTIAL unique index so the
-- worker can `INSERT ... ON CONFLICT DO NOTHING`. Telegram / live-chat rows
-- keep provider_message_id = NULL and are unaffected (the predicate excludes
-- them), so existing inserts continue to work unchanged.
--
-- Safe to run multiple times.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS provider_message_id text;

-- One row per (conversation, provider message id) when an id is present.
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_provider_id
  ON messages (conversation_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
