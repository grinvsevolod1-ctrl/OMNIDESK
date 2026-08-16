-- 088: A/B experiments over the seller brain.
--
-- ai_experiments: one row per experiment. Branch A = control (master settings
-- untouched), branch B = master settings + overrides (persona/tone/
-- aggressiveness/extra directive). At most ONE experiment may be active —
-- enforced by the partial unique index, not by application hope.
--
-- ai_experiment_assignments: which branch each conversation actually got.
-- The branch itself is a deterministic hash (lib/ai/experiment.ts), so this
-- table is not needed to AGREE on a branch — it exists so results can be
-- computed in SQL over exactly the conversations that generated at least one
-- reply while the experiment ran (no phantom conversations in either bucket).

CREATE TABLE IF NOT EXISTS ai_experiments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  stopped_at  TIMESTAMPTZ,
  -- Filled on stop when the admin declares a winner ('A' | 'B'); NULL = draw
  -- or stopped without a verdict.
  winner      TEXT CHECK (winner IN ('A', 'B'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_experiments_one_active
  ON ai_experiments (status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ai_experiment_assignments (
  experiment_id   UUID NOT NULL REFERENCES ai_experiments(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch          TEXT NOT NULL CHECK (branch IN ('A', 'B')),
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS ai_experiment_assignments_exp_branch
  ON ai_experiment_assignments (experiment_id, branch);
