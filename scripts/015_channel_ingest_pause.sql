-- Adds a "soft pause" for personal channels (telegram/whatsapp).
--
-- When ingest_paused = true the worker keeps the account's session ALIVE and
-- connected (so it is never flagged/relinked), but stops writing inbound
-- messages/history into the inbox. This is distinct from session_status:
-- the account stays `online`, only inbound persistence is suppressed.
--
-- Safe to run multiple times.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS ingest_paused boolean NOT NULL DEFAULT false;
