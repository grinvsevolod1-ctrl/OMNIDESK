-- 083_ai_aggressiveness.sql
-- Adds a configurable persuasion-intensity dial for the AI sales manager.
--
-- aggressiveness controls how hard the "god of sales" pushes toward the goal:
--   0 = gentle    — informs, never pressures; backs off on the first "no".
--   1 = steady    — light nudges, one soft follow-up.
--   2 = assertive — persistent objection handling (DEFAULT = current behavior).
--   3 = relentless — maximum pressure, chains every persuasion lever, rarely
--                     lets go (still bounded by the ethical floor in the prompt).
--
-- Default 2 preserves today's behavior exactly for existing deployments.
ALTER TABLE ai_assist_settings
  ADD COLUMN IF NOT EXISTS aggressiveness smallint NOT NULL DEFAULT 2;

-- Clamp any out-of-range values defensively (idempotent, safe on re-run).
UPDATE ai_assist_settings
   SET aggressiveness = GREATEST(0, LEAST(3, aggressiveness))
 WHERE aggressiveness < 0 OR aggressiveness > 3;

ALTER TABLE ai_assist_settings
  DROP CONSTRAINT IF EXISTS ai_assist_settings_aggr_check;
ALTER TABLE ai_assist_settings
  ADD CONSTRAINT ai_assist_settings_aggr_check
  CHECK (aggressiveness BETWEEN 0 AND 3);
