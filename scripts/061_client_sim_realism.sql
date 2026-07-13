-- Client simulator — realism + reliability upgrade.
--
-- Adds three things, all backward-compatible and safe to run repeatedly:
--
--   1) sim_settings.max_concurrent — an INDEPENDENT cap on how many dialogues
--      may be live at once (up to ~100+ "people" chatting simultaneously),
--      decoupled from the daily throughput knob. Previously concurrency was
--      derived from dialogs_per_day (perDay/3), which capped a low-throughput
--      setup at a handful of threads even if the operator wanted a big crowd.
--
--   2) sim_threads.outcome — WHY a dialogue ended, so the panel/logs can show
--      the client's "fate" (переписался и ушёл / ушёл к конкуренту / пропал /
--      наругался) instead of a flat "done". NULL while the dialogue is live.
--
--   3) sim_threads.nudge_attempts / nudge_next_at — per-dialogue backoff for the
--      backlog "nudge the AI manager" sweep. Without this, a dialogue the AI
--      never answers (e.g. the master switch is off) gets poked every ~5s
--      forever, flooding the log and hammering the gateway. Backoff spaces the
--      retries out exponentially and the sweep skips a dialogue until its
--      nudge_next_at arrives.
--
-- The `state` column is plain text with NO check constraint, so the new
-- lifecycle states ('later' | 'sleeping' | 'vanished') work with no schema
-- change. They are all non-terminal (state <> 'done'), so existing "active"
-- queries and the idx_sim_threads_due partial index already include them.

ALTER TABLE sim_settings
  ADD COLUMN IF NOT EXISTS max_concurrent integer NOT NULL DEFAULT 100;

ALTER TABLE sim_threads
  ADD COLUMN IF NOT EXISTS outcome        text;
ALTER TABLE sim_threads
  ADD COLUMN IF NOT EXISTS nudge_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE sim_threads
  ADD COLUMN IF NOT EXISTS nudge_next_at  timestamptz;

-- Helps the outcome breakdown query on the dashboard stay cheap.
CREATE INDEX IF NOT EXISTS idx_sim_threads_outcome
  ON sim_threads(outcome)
  WHERE outcome IS NOT NULL;
