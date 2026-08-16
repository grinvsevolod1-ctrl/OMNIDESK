-- AI global-lead mode + per-conversation pause + handoff-to-liquid tracking.
--
-- Product change: the AI master switch (ai_assist_settings.enabled) now means
-- "the AI leads EVERY conversation by default". Managers no longer opt a
-- conversation IN; instead they can opt a specific conversation OUT (pause),
-- e.g. to take over by hand.
--
--   effective "AI is leading this conversation"
--     = ai_assist_settings.enabled AND NOT conversations.ai_paused
--
-- The legacy per-conversation flag `ai_autopilot_enabled` (migration 054) is
-- kept for backward compatibility but is no longer read by the runtimes.
--
-- Safe to run multiple times.

-- Per-conversation manual pause (opt-out). Default false => led when global on.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_paused boolean NOT NULL DEFAULT false;

-- The AI decided this lead is ready ("Ликвид") and handed it to a human. Stays
-- true until a manager acknowledges it (opens the thread), so the inbox can
-- surface a banner + highlight without nagging repeatedly.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_pending boolean NOT NULL DEFAULT false;

-- When the handoff happened (for ordering the notifications, newest first).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_at timestamptz;

-- Fast lookup of "which conversations are paused" for the schedulers.
CREATE INDEX IF NOT EXISTS idx_conversations_ai_paused
  ON conversations(id)
  WHERE ai_paused = true;

-- Fast lookup of pending handoffs to show the manager banner.
CREATE INDEX IF NOT EXISTS idx_conversations_ai_handoff_pending
  ON conversations(manager_id, ai_handoff_at DESC)
  WHERE ai_handoff_pending = true;
