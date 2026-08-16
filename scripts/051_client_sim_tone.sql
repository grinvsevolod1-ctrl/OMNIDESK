-- Client simulator: writing tone/register selector.
-- Adds a single column controlling how simulated clients speak. 'mixed'
-- preserves the previous randomised behaviour for existing installs.
ALTER TABLE sim_settings
  ADD COLUMN IF NOT EXISTS tone text NOT NULL DEFAULT 'mixed';
