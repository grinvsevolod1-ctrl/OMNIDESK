-- Client simulator: single autonomous throughput knob.
-- The simulator is simplified to ONE control — how many brand-new dialogues
-- the bots should open per day. All other pacing (concurrency, spawn jitter,
-- reply delays) is now derived autonomously by the engine from this number,
-- and each persona rolls its own tone/aggression for maximum variety, so the
-- legacy columns (aggression, tone, max_threads, spawn_*_sec, reply_*_sec)
-- are intentionally kept but no longer read by the UI.
ALTER TABLE sim_settings
  ADD COLUMN IF NOT EXISTS dialogs_per_day integer NOT NULL DEFAULT 20;
