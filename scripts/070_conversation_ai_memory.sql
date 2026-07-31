-- 070_conversation_ai_memory.sql
-- Phase 1 (manager brain): durable per-conversation memory so the AI never
-- "forgets" facts on a long dialog and never re-asks what the client already
-- told it. Strictly scoped to the manager-brain runtime — the client simulator
-- (is_simulated) never reads or writes this table.
--
-- Invariants preserved:
--   * One memory row per conversation (1:1), lazily created.
--   * Additive: no existing column/table is altered.
--   * Cascade-deletes with the conversation, so god-panel dialog deletion stays
--     clean and leaves no orphans.

CREATE TABLE IF NOT EXISTS conversation_ai_memory (
  conversation_id uuid PRIMARY KEY
    REFERENCES conversations(id) ON DELETE CASCADE,
  -- Compact, model-maintained summary of durable facts about this client:
  -- name, city, budget, objections raised, agreements, next step, etc.
  -- Kept short (a handful of lines) and injected verbatim into the system
  -- prompt instead of replaying the whole transcript.
  summary text NOT NULL DEFAULT '',
  -- How many client turns were folded into `summary` last time it was rebuilt,
  -- so the runtime can decide when a refresh is worthwhile.
  turns_seen integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE conversation_ai_memory IS
  'Manager-brain long-term memory (durable client facts) per conversation. Never used by the client simulator.';
