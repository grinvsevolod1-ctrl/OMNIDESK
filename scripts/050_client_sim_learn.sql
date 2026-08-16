-- Client simulator: persisted "learned profile".
--
-- When an admin runs "Изучить все диалоги", the AI reads real conversations and
-- distills a style/behaviour profile (tone, common topics, concrete writing
-- pointers, representative phrases). We store that single JSON blob on the
-- singleton sim_settings row so the generator can reuse it across restarts.
--
-- Safe to run multiple times.

ALTER TABLE sim_settings
  ADD COLUMN IF NOT EXISTS learned_profile jsonb;
