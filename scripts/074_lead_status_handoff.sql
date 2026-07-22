-- Add the «Передан человеку» (handoff) lead status.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/074_lead_status_handoff.sql
--
-- Background
-- ----------
-- Previously the AI, when it decided a lead was ready, auto-promoted the
-- conversation straight to 'liquid' («Ликвид») on handoff. That conflated two
-- very different things:
--   * an automatic "the bot passed this to a human" signal, and
--   * a manual, human business judgement ("this lead matches our audience").
--
-- From now on:
--   * 'handoff'  is set AUTOMATICALLY the moment the AI hands a dialogue to a
--                human, or a manager steps into the dialogue themselves.
--   * 'liquid' / 'not_liquid' / 'transferred' are set ONLY by a manager, by hand.
--
-- This migration is safe to run more than once (idempotent).

-- 1) Relax the CHECK so we can write the new value and remap old rows.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_status_check;

-- 2) Backfill: move leads the AI auto-promoted to «Ликвид» into «Передан
--    человеку». We can tell an AI-driven promotion from a genuine manual
--    «Ликвид» because the AI handoff always stamps ai_handoff_at (see
--    markAiHandoffToHuman); a manager classifying a lead by hand never does.
--    Manager-set «Ликвид» is therefore left untouched.
UPDATE conversations
   SET status = 'handoff',
       status_detail = NULL
 WHERE status = 'liquid'
   AND ai_handoff_at IS NOT NULL;

-- 3) Re-add the CHECK, now including 'handoff'.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check
    CHECK (status IN ('unsubscribed', 'handoff', 'liquid', 'not_liquid', 'transferred'));

-- 4) status_detail stays valid only for «Не ликвид»; the handoff backfill above
--    already cleared it on the rows it touched, so the existing
--    conversations_status_detail_check keeps holding. Re-assert it defensively
--    in case an older database never had it.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_status_detail_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_detail_check
    CHECK (
      status_detail IS NULL
      OR (status = 'not_liquid'
          AND status_detail IN ('geo', 'under18', 'na', 'trash'))
    );
