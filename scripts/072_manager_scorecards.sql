-- 072_manager_scorecards.sql
-- Phase 4: manager scoring + sim→brain learning loop.
--
-- When a SIMULATED dialogue ends, the "client-expert" scores how the AI manager
-- handled it (0..100) with concrete strengths/weaknesses. Those weaknesses are
-- distilled into an auto-derived lesson that feeds straight back into the
-- manager brain via ai_assist_lessons — closing the self-play training loop.
--
-- Scorecards are keyed by conversation so re-scoring the same dialogue updates
-- rather than duplicates. Only simulated conversations are ever scored.

CREATE TABLE IF NOT EXISTS manager_scorecards (
  conversation_id uuid PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  -- Overall grade for the manager's handling of this dialogue, 0..100.
  score         integer NOT NULL DEFAULT 0,
  -- Final outcome label copied from the sim thread (ended/left/competitor/...).
  outcome       text NOT NULL DEFAULT '',
  -- What the manager did well (bullet lines joined by newline).
  strengths     text NOT NULL DEFAULT '',
  -- What the manager did poorly / missed (bullet lines joined by newline).
  weaknesses    text NOT NULL DEFAULT '',
  -- One-line verdict shown in the panel.
  summary       text NOT NULL DEFAULT '',
  -- How many client/manager turns the dialogue ran (context for the score).
  turns         integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Dashboard reads recent cards and averages, so index by recency.
CREATE INDEX IF NOT EXISTS idx_manager_scorecards_created
  ON manager_scorecards (created_at DESC);

-- Tag auto-derived lessons so the panel can distinguish them from hand-written
-- corrections. Nullable/defaulted so existing rows and inserts stay valid.
ALTER TABLE ai_assist_lessons
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
