-- AI manager-assistant: a trainable "brain" that can auto-run conversations.
--
-- Three pieces:
--   1) ai_assist_settings — a SINGLETON (id = true) global config row. Per the
--      product decision the knowledge base is shared across ALL managers, so
--      there is exactly one settings row and one shared playbook.
--   2) ai_assist_lessons — the training corpus. Every time an admin corrects a
--      suggested reply in the trainer, we store {situation, draft, corrected}
--      as a "lesson". The generator retrieves recent/relevant lessons to steer
--      future replies (lightweight RAG-by-recency, no embeddings needed).
--   3) conversations.ai_autopilot_enabled — a PER-CONVERSATION toggle. When a
--      manager flips it on, the AI leads that specific dialog. When the manager
--      sends a manual message, we auto-clear the flag (human takes over). The
--      manager can re-enable it and the AI re-reads the thread and continues.
--
-- Safe to run multiple times.

-- 1) Singleton settings + shared distilled playbook.
CREATE TABLE IF NOT EXISTS ai_assist_settings (
  id            boolean PRIMARY KEY DEFAULT true,
  -- Master switch. When false, managers cannot turn AI on for conversations
  -- and no auto-replies are generated.
  enabled       boolean NOT NULL DEFAULT false,
  -- Reply tone/register hint fed into the system prompt.
  tone          text NOT NULL DEFAULT 'professional',
  -- Free-form business context the admin writes (what the company does, how to
  -- talk to clients, what to offer). Always injected into the prompt.
  persona       text NOT NULL DEFAULT '',
  -- Distilled bullet-point playbook produced from lessons (kept small so it can
  -- always be injected cheaply). Updated as the admin trains.
  playbook      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_assist_settings_singleton CHECK (id = true)
);

INSERT INTO ai_assist_settings (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;

-- 2) Training corpus.
CREATE TABLE IF NOT EXISTS ai_assist_lessons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The incoming client message / situation the reply responded to.
  situation     text NOT NULL DEFAULT '',
  -- What the AI originally suggested (may be empty for hand-authored lessons).
  draft         text NOT NULL DEFAULT '',
  -- The admin-approved final wording — the thing worth learning from.
  corrected     text NOT NULL DEFAULT '',
  -- Optional short note on WHY, written by the admin.
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_assist_lessons_recent
  ON ai_assist_lessons(created_at DESC);

-- 3) Per-conversation AI-lead toggle.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_autopilot_enabled boolean NOT NULL DEFAULT false;

-- Cheap lookup of "which conversations are AI-led" for the schedulers.
CREATE INDEX IF NOT EXISTS idx_conversations_ai_autopilot
  ON conversations(id)
  WHERE ai_autopilot_enabled = true;

-- Reuse the existing is_autopilot flag on messages (added in 030) to tag
-- AI-authored sends, so a manual human send is easy to distinguish.
