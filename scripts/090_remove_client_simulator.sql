-- 090_remove_client_simulator.sql
--
-- Removes the client simulator "с концами". The simulator generated AI-manager
-- test dialogs; the product now creates leads ONLY manually. Every trace of the
-- simulator engine is dropped, but the dialogs it already created are KEPT and
-- converted into ordinary real dialogs:
--
--   1. Drop the simulator's own tables (settings, live thread state, auto
--      corrections). These hold only engine state — sim_threads has an FK TO
--      conversations, not the other way round, so dropping it never touches the
--      conversations themselves. CASCADE also removes their indexes and FKs.
--   2. Drop the is_simulated column and its index. This alone strips the
--      "Simulated" status from every existing dialog: the rows stay exactly as
--      they are (contact, messages, status, manager) and are indistinguishable
--      from any other real conversation afterwards.
--
-- No conversations are deleted. Runs inside the migration runner's per-file
-- transaction, so it is atomic.

-- 1. Drop the simulator tables outright (engine-only state; conversations are
--    left untouched).
DROP TABLE IF EXISTS sim_manual_corrections CASCADE;
DROP TABLE IF EXISTS sim_threads CASCADE;
DROP TABLE IF EXISTS sim_settings CASCADE;

-- 2. Drop the source flag and its index from conversations. Removing the column
--    turns every previously-simulated dialog into a plain real dialog.
DROP INDEX IF EXISTS idx_conversations_is_simulated;
ALTER TABLE conversations DROP COLUMN IF EXISTS is_simulated;
