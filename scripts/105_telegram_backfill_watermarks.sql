-- 105: Per-chat backfill watermarks for Telegram history sync.
--
-- Problem this fixes: every reconnect re-ran the FULL history backfill for
-- every chat from the newest message all the way back to the very first one.
-- Ingest is idempotent so no duplicates appeared, but the requests themselves
-- re-read the entire history each time — for an account with hundreds of
-- chats that is hours of getMessages paging per reconnect, gratuitous flood
-- risk, and pointless database load.
--
-- With watermarks each chat tracks how far history has been synced:
--   * newest_synced_id — the top of what we have; on reconnect only messages
--     NEWER than this are fetched (the offline gap), typically one small page.
--   * oldest_synced_id + complete — progress of the one-time deep backfill;
--     an interrupted backfill resumes where it stopped instead of restarting.

CREATE TABLE IF NOT EXISTS telegram_backfill_watermarks (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact_handle text NOT NULL,
  -- Telegram message ids are per-chat int32 sequence numbers.
  newest_synced_id bigint NOT NULL DEFAULT 0,
  oldest_synced_id bigint NOT NULL DEFAULT 0,
  -- True once the deep backfill reached the first message of the chat (or the
  -- TG_BACKFILL_PER_CHAT cap): the historic phase never runs again for it.
  complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, contact_handle)
);

COMMENT ON TABLE telegram_backfill_watermarks IS
  'Per-chat history sync progress: reconnects fetch only the offline gap instead of re-paging the entire chat history.';
