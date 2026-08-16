-- Omnidesk migration 020: durable Telegram peer (access_hash) cache.
--
-- Why: MTProto cannot message or mark-read a numeric user/channel without that
-- peer's access_hash. GramJS keeps access_hashes in an in-memory entity cache
-- that is rebuilt from the string session on every worker restart and is often
-- incomplete, which surfaces as:
--   "Could not find the input entity for {userId: ...}"
--
-- We see every contact's entity (with its access_hash) when their messages
-- arrive and when dialogs sync. Persisting those lets the worker reconstruct an
-- InputPeerUser / InputPeerChannel directly, independent of the volatile cache.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/020_telegram_peers.sql

CREATE TABLE IF NOT EXISTS telegram_peers (
  channel_id   UUID NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  -- The stored conversation handle (marked peer id string, matching
  -- conversations.contact_handle for this channel).
  handle       TEXT NOT NULL,
  -- Peer kind: 'user' | 'channel' | 'chat'. 'chat' (basic groups) needs no
  -- access_hash, only its id.
  kind         TEXT NOT NULL CHECK (kind IN ('user', 'channel', 'chat')),
  -- Unmarked numeric id of the peer, as text (bigint-safe).
  peer_id      TEXT NOT NULL,
  -- access_hash as text; NULL for basic 'chat' peers.
  access_hash  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, handle)
);
