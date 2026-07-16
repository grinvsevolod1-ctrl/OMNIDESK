-- Auto-enroll NEW dialogs into the AI manager.
--
-- Product change on top of 065's strict per-dialog opt-in:
--
--   * NEW dialogs  -> the AI joins automatically the moment they are created.
--   * OLD dialogs  -> stay exactly as they were; the admin still enrolls those
--                     by hand. This migration does NOT backfill existing rows,
--                     so nothing that was previously "manual / off" turns on.
--
-- Implementation: flip the column DEFAULTS only. Every INSERT that omits
-- ai_enrolled / ai_enrolled_at (all of them today) now gets an enrolled,
-- timestamped dialog for free — including simulator dialogs, which must be
-- AI-led too (the AI treats a simulated client exactly like a real one). We
-- intentionally leave ai_enrolled_from_message_id NULL for new dialogs: there
-- is no prior backlog to skip, so the brain reads the thread from its first
-- message.
--
-- Safe to run multiple times.

-- New dialogs are AI-led out of the box.
ALTER TABLE conversations
  ALTER COLUMN ai_enrolled SET DEFAULT true;

-- Stamp the enrollment time on creation so the "AI-led" list (ordered by
-- ai_enrolled_at DESC) shows freshly-created dialogs in the right place.
ALTER TABLE conversations
  ALTER COLUMN ai_enrolled_at SET DEFAULT now();

-- NOTE: existing rows are deliberately NOT updated. Old dialogs keep whatever
-- ai_enrolled value they already have, preserving the "old dialogs only by my
-- command" rule.
