-- AI activity log — a lightweight, real-time trail of what the AI is doing.
--
-- Purpose: give the admin visibility into the "black box" of the assistant. It
-- captures the decision points and outcomes that were previously only written
-- to the server console and swallowed — WHY the AI stayed silent (master switch
-- off, conversation not AI-led, gateway out of credits / bad key, refusal), the
-- replies it generated (its "thoughts"), lead promotions, and errors. The panel
-- "Логи" tab tails this table in near real time.
--
-- Written from BOTH runtimes (the Next.js panel AND the standalone worker) so a
-- single stream shows live-chat + messenger + simulator activity together.
--
-- It is intentionally a capped ring-buffer: writers trim old rows so the table
-- can never grow unbounded (this is diagnostics, not an audit log).
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS ai_logs (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- debug | info | warn | error — drives colour + filtering in the UI.
  level           text NOT NULL DEFAULT 'info',
  -- Which subsystem emitted it: 'ai-lead' | 'brain' | 'gateway' | 'sim' |
  -- 'handoff' | 'worker'. Free-form so new sources don't need a migration.
  source          text NOT NULL DEFAULT 'ai',
  -- Short machine-ish label, e.g. 'reply.generated', 'gateway.http_error'.
  event           text NOT NULL DEFAULT '',
  -- Human-readable detail / the model's reasoning or output preview.
  message         text NOT NULL DEFAULT '',
  -- Optional links for filtering / jumping to a thread.
  conversation_id uuid,
  channel_type    text,
  -- Optional structured extras (status codes, model id, counts, etc.).
  meta            jsonb
);

-- Newest-first tail is the only access pattern.
CREATE INDEX IF NOT EXISTS idx_ai_logs_recent ON ai_logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_logs_level ON ai_logs(level, id DESC);
