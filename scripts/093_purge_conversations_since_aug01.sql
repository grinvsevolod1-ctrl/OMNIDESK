-- 093_purge_conversations_since_aug01.sql
--
-- One-off cleanup: permanently delete EVERY conversation created in the 5-day
-- window from 2026-07-28 up to and including 2026-08-01 (i.e. 28.07, 29.07,
-- 30.07, 31.07, 01.08) — including real client dialogs across ALL managers, not
-- just the former simulated ones. Deleting a conversation cascades to all of its
-- messages and dependent rows (message reads, autopilot state, transfers, ai
-- logs, etc.) via ON DELETE CASCADE. Telemost meeting history is preserved —
-- its conversation_id is set NULL rather than deleted.
--
-- The whole statement runs inside the migration runner's transaction, so it is
-- all-or-nothing. This migration is idempotent in effect: re-running it simply
-- finds no matching rows once the batch is gone.

DELETE FROM conversations
WHERE created_at >= TIMESTAMPTZ '2026-07-28 00:00:00'
  AND created_at <  TIMESTAMPTZ '2026-08-02 00:00:00';
