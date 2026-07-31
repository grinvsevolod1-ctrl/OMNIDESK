-- Migration 080: sim_content_config
-- Adds a JSONB column to sim_settings that holds all previously-hardcoded
-- content pools for the client simulator (site name, vacancies, cities,
-- schedule types, match-% range, persona name banks, archetypes, tempers,
-- occupations, motivations, life details, quirks, goals, opener templates,
-- and mood-phrase banks). When NULL the generator falls back to the default
-- constants in lib/client-sim/generate.ts (SIM_CONTENT_DEFAULTS) and
-- lib/client-sim/content/data.ts so existing deployments keep working
-- without running this migration.

ALTER TABLE sim_settings
  ADD COLUMN IF NOT EXISTS content_config JSONB DEFAULT NULL;

COMMENT ON COLUMN sim_settings.content_config IS
  'Operator-editable content pools for the simulator. NULL = use hardcoded defaults.';
