-- Phase 0 — AI model configuration + generation metrics (A/B foundation).
--
-- Two additive, backward-compatible changes. Nothing here alters existing AI
-- behaviour: the new columns default to the values that were previously
-- hard-coded in lib/ai/manager-brain.ts, so an un-migrated call path and a
-- migrated one produce identical requests.
--
-- Safe to run multiple times.

-- 1) Make the manager-brain model tunable from the admin panel (was hard-coded
--    to 'openai/gpt-4.1' with temperature 0.7 / max_tokens 400). The MANAGER_AI_MODEL
--    env var still works as a fallback default in code; this row, when set to a
--    non-empty model, takes precedence so admins can switch models without a redeploy.
ALTER TABLE ai_assist_settings
  ADD COLUMN IF NOT EXISTS model       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS temperature real NOT NULL DEFAULT 0.7,
  ADD COLUMN IF NOT EXISTS max_tokens  integer NOT NULL DEFAULT 400;

-- Keep temperature/max_tokens in sane bounds even if written directly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_assist_settings_temp_range'
  ) THEN
    ALTER TABLE ai_assist_settings
      ADD CONSTRAINT ai_assist_settings_temp_range
      CHECK (temperature >= 0 AND temperature <= 2);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_assist_settings_maxtok_range'
  ) THEN
    ALTER TABLE ai_assist_settings
      ADD CONSTRAINT ai_assist_settings_maxtok_range
      CHECK (max_tokens >= 50 AND max_tokens <= 4000);
  END IF;
END $$;

-- 2) Durable generation metrics for comparing models (A/B) and watching latency
--    / failure rates over time. Unlike ai_logs (a capped diagnostics ring-buffer)
--    this is a lean, long-lived analytics table: one row per manager-brain call.
CREATE TABLE IF NOT EXISTS ai_generation_metrics (
  id                bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Model id actually used for the call (e.g. 'openai/gpt-4.1').
  model             text NOT NULL DEFAULT '',
  -- Which runtime issued it: 'livechat' | 'worker' | 'trainer'.
  runtime           text NOT NULL DEFAULT '',
  -- What the call was for: 'reply' | 'assess'.
  purpose           text NOT NULL DEFAULT 'reply',
  -- Result bucket: 'ok' | 'empty' | 'refused' | 'http_error' | 'exception'.
  outcome           text NOT NULL DEFAULT 'ok',
  -- Round-trip latency to the gateway in milliseconds.
  latency_ms        integer,
  -- Token usage when the gateway reports it (nullable).
  prompt_tokens     integer,
  completion_tokens integer,
  conversation_id   uuid
);

-- Access patterns: per-model aggregation over a recent window, and a raw tail.
CREATE INDEX IF NOT EXISTS idx_ai_gen_metrics_model
  ON ai_generation_metrics(model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_gen_metrics_recent
  ON ai_generation_metrics(created_at DESC);
