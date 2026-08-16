-- 073_client_sim_thread_pause.sql
--
-- Per-conversation pause switch for the client simulator.
--
-- When an operator steps into a single dialogue from the god console (writes a
-- message by hand), we must detach the simulator FROM THAT ONE dialogue only —
-- every other live thread keeps running. This adds a `paused` flag on
-- sim_threads and rebuilds the "due" index so paused threads are never claimed
-- by the scheduler. Re-enabling clears the flag and re-arms next_run_at so the
-- engine re-reads the full transcript (including the operator's manual lines)
-- and continues in the same persona.
--
-- Idempotent: safe to run repeatedly and on a DB that predates this file.

ALTER TABLE sim_threads
  ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

ALTER TABLE sim_threads
  ADD COLUMN IF NOT EXISTS paused_at timestamptz;

-- Rebuild the due-scheduler index so paused threads drop out of it entirely.
DROP INDEX IF EXISTS idx_sim_threads_due;
CREATE INDEX IF NOT EXISTS idx_sim_threads_due
  ON sim_threads(next_run_at)
  WHERE state <> 'done' AND paused = false;
