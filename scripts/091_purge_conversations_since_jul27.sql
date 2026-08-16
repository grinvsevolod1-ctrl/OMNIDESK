-- 091_purge_conversations_since_jul27.sql
--
-- One-off cleanup: permanently delete every conversation created on or after
-- 2026-07-27 (the "last 4 days" batch). Deleting a conversation cascades to all
-- of its messages and dependent rows (message reads, autopilot state, transfers,
-- ai logs, etc.) via ON DELETE CASCADE. Telemost meeting history is preserved —
-- its conversation_id is set NULL rather than deleted.
--
-- The whole statement runs inside the migration runner's transaction, so it is
-- all-or-nothing. This migration is idempotent in effect: re-running it simply
-- finds no matching rows once the batch is gone.

DELETE FROM conversations
WHERE created_at >= TIMESTAMPTZ '2026-07-27 00:00:00';
