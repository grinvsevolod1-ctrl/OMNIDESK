-- Client simulator: "campaign" scheduler.
-- Lets the operator run a bounded burst — "create N brand-new dialogues over the
-- next H hours" — instead of (or on top of) the steady per-day rate. When a
-- campaign is active the engine paces spawns to hit `campaign_target` new
-- dialogues by `campaign_ends_at`, then auto-stops the campaign (the steady
-- dialogs_per_day rate resumes only if the operator left it running).
--
-- All columns are optional/additive and probed at runtime by the store, so an
-- install that hasn't applied this migration keeps working on the steady rate.
-- Safe to run multiple times.

ALTER TABLE sim_settings
  ADD COLUMN IF NOT EXISTS campaign_active   boolean     NOT NULL DEFAULT false,
  -- how many brand-new dialogues this campaign should open in total
  ADD COLUMN IF NOT EXISTS campaign_target   integer     NOT NULL DEFAULT 0,
  -- when the campaign window closes (spawns are paced to finish by this time)
  ADD COLUMN IF NOT EXISTS campaign_ends_at  timestamptz,
  -- spawned_total at the moment the campaign started, so progress = spawned_total - baseline
  ADD COLUMN IF NOT EXISTS campaign_baseline integer     NOT NULL DEFAULT 0,
  -- when the campaign was started (for display)
  ADD COLUMN IF NOT EXISTS campaign_started_at timestamptz;
