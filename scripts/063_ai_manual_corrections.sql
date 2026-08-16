-- Manual AI corrections — the admin's hand-written, per-message teaching notes.
--
-- Purpose: in /admin/ai the admin opens a real dialog, selects ANY message
-- (client or AI/manager), and writes what was wrong and what should have been
-- done instead ("здесь ты перевёл на менеджера — это неправильно, потому что…").
-- These are the highest-value, human-authored lessons and must be treated as
-- STRICT, ALWAYS-ON rules: unlike the distilled playbook (capped, re-derived)
-- and the style lessons (capped, newest-first), manual corrections are injected
-- into EVERY brain prompt and are never distilled away or forgotten.
--
-- Durability requirement (explicit product ask): the AI must keep learning from
-- past chats "even if I later delete the Telegram account". So this table has
-- NO foreign key to channels/conversations — deleting a channel cascades away
-- the raw conversations/messages, but the teaching survives here forever. The
-- conversation_id/channel_id columns are plain, nullable references kept only
-- for optional back-linking in the UI; they are allowed to dangle.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS ai_manual_corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Optional, DANGLING-ALLOWED back-links (no FK on purpose — see header).
  conversation_id uuid,
  channel_id      uuid,
  -- Which account this was taught from, captured as text so it survives even
  -- after the channel row is deleted (e.g. 'telegram (+7…)').
  account_label   text NOT NULL DEFAULT '',
  -- The situation the correction applies to: a short transcript window ending
  -- with the exact message the admin selected, speaker-labelled.
  context         text NOT NULL DEFAULT '',
  -- Who authored the selected message: 'client' | 'ai' | 'manager'.
  target_role     text NOT NULL DEFAULT 'ai',
  -- The exact text of the selected message (quoted verbatim in the prompt).
  target_message  text NOT NULL DEFAULT '',
  -- The admin's instruction: what was wrong and what to do instead. This is the
  -- rule the AI must always obey.
  instruction     text NOT NULL DEFAULT ''
);

-- Newest-first is the injection + management access pattern.
CREATE INDEX IF NOT EXISTS idx_ai_manual_corrections_recent
  ON ai_manual_corrections(created_at DESC);
