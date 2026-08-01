-- 090_remove_client_simulator.sql
--
-- Removes the client simulator "с концами". The simulator generated fake client
-- personas and drove AI-manager test dialogs; the product now creates leads
-- ONLY manually, so every trace of it is dropped:
--
--   1. Purge the fake conversations it created (is_simulated = true). Messages
--      and every conversation-scoped child row cascade away via their existing
--      ON DELETE CASCADE FKs, so no orphans and no fake leads linger in the
--      real inbox.
--   2. Drop the simulator's own tables (settings, live thread state, auto
--      corrections). CASCADE also removes their indexes and FKs.
--   3. Drop the is_simulated column and its index — the concept no longer
--      exists, so no code path needs to distinguish simulated from real.
--
-- Runs inside the migration runner's per-file transaction, so it is atomic.

-- 1. Purge simulated conversations (cascades to messages, transfers, memory,
--    scorecards, follow-ups, experiments, autopilot state, sim_threads, etc.).
DELETE FROM conversations WHERE is_simulated = true;

-- 2. Drop the simulator tables outright.
DROP TABLE IF EXISTS sim_manual_corrections CASCADE;
DROP TABLE IF EXISTS sim_threads CASCADE;
DROP TABLE IF EXISTS sim_settings CASCADE;

-- 3. Drop the source flag and its index from conversations.
DROP INDEX IF EXISTS idx_conversations_is_simulated;
ALTER TABLE conversations DROP COLUMN IF EXISTS is_simulated;
