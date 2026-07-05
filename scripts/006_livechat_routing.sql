-- Live-chat routing: manager pool + round-robin distribution.
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/006_livechat_routing.sql
--
-- No new tables/columns. A live-chat "resource" is a single channel of
-- type='livechat' (one API key / one site). Routing state lives in the existing
-- channels.config JSONB:
--
--   config.pool      TEXT[]  -- ordered manager ids that share this site's chats
--   config.rrCursor  INT     -- round-robin pointer, atomically incremented
--
-- Distribution rule (implemented in lib/data.ts):
--   * A visitor is keyed by (channel_id, contact_handle) in `conversations`.
--   * First message from a new visitor -> pick the next manager from config.pool
--     via round-robin (the UPDATE row-locks the channel row, so visitors that
--     arrive in parallel are serialized and never skip/collide).
--   * Any later message from the same visitor reuses the existing conversation,
--     so it stays with the already-assigned manager (sticky; no manager switch).
--   * Empty pool -> falls back to the channel owner (channels.manager_id), which
--     preserves the previous single-manager behaviour.

-- Speeds up the per-visitor sticky lookup done on every inbound message.
CREATE INDEX IF NOT EXISTS idx_conversations_channel_handle
  ON conversations (channel_id, contact_handle, last_message_at DESC);

-- Backfill: seed each existing live-chat channel's pool with its current owner
-- so behaviour is unchanged until an admin assigns more managers.
UPDATE channels
   SET config = jsonb_set(
         COALESCE(config, '{}'::jsonb),
         '{pool}',
         to_jsonb(ARRAY[manager_id::text])
       )
 WHERE type = 'livechat'
   AND (config->'pool') IS NULL;
