-- 085_ai_directives.sql
-- Chat-driven "mandate" for the AI sales manager.
--
-- Everything the admin dictates to the co-pilot in plain language ("always ask
-- for the budget first", "never promise a discount above 10%", "if they mention
-- a competitor, do X") is stored here as an ordered, individually toggleable
-- list of directives. Unlike:
--   * persona  — one free-text scenario blob,
--   * playbook — auto-distilled from training (gets OVERWRITTEN each re-distill),
--   * lessons  — situation→answer examples,
--   * corrections — per-message fixes,
-- directives are durable, hand-managed rules that survive training and are
-- injected into EVERY reply at the highest priority (right under the scenario).
-- This is the storage behind "the admin says it in chat and that's how it is".
--
-- Strictly AI-manager scope: this table has nothing to do with the client
-- simulator or the god panel and is never read by them.
CREATE TABLE IF NOT EXISTS ai_directives (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The rule itself, verbatim as the admin phrased it (co-pilot may tidy it).
  body        text NOT NULL,
  -- Manual ordering; lower = higher in the prompt. Admin can reorder via chat.
  sort_order  integer NOT NULL DEFAULT 0,
  -- Soft on/off so a rule can be paused without losing it.
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Fast ordered reads of the active mandate (the hot path on every reply).
CREATE INDEX IF NOT EXISTS ai_directives_order_idx
  ON ai_directives (enabled, sort_order, created_at);
