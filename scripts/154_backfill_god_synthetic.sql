-- 154: Backfill god_synthetic for PRE-153 god dialogs + clear their stale red
-- ticks.
--
-- Migration 153 added conversations.god_synthetic but only NEW dialogs created
-- from the god messenger get the flag. Every dialog created BEFORE 153 still
-- has god_synthetic = false, so an outbound send to it is dispatched to
-- Telegram for real — where the peer has no cached access_hash — and fails with
-- "Could not find the input entity for PeerUser(...)". The manager/curator then
-- sees a permanent failed red tick even though these threads are supposed to be
-- self-sufficient (AGENTS.md §4.3).
--
-- Fingerprint used to recognise a pre-153 god dialog (all must hold):
--   * it has an outbound message that FAILED with the input-entity error — that
--     specific error only happens for a peer Telegram was never told about,
--     i.e. a fabricated god contact (a real inbound-first contact always has a
--     cached access_hash; a bad @username fails with USERNAME_* instead), AND
--   * it has NEVER received an inbound message — a real person who wrote to the
--     account first would have one. God synthetic contacts never wrote in.
--
-- This ONLY governs send simulation, never visibility/analytics.

UPDATE conversations c
   SET god_synthetic = true
 WHERE c.god_synthetic = false
   AND EXISTS (
     SELECT 1 FROM messages m
      WHERE m.conversation_id = c.id
        AND m.direction = 'out'
        AND m.status = 'failed'
        AND m.error_reason ILIKE '%input entity%'
   )
   AND NOT EXISTS (
     SELECT 1 FROM messages mi
      WHERE mi.conversation_id = c.id
        AND mi.direction = 'in'
   );

-- Clear the permanent red "!" on historical god sends. They never really went
-- to Telegram, and going forward the worker settles them as delivered, so the
-- stored failed status is a pure artifact. Restricted to the input-entity
-- artifact and to NON-blocked synthetic dialogs — a dialog the operator marked
-- "Заблокировать" in the god messenger intentionally keeps its failed ticks to
-- mimic being blocked on the far side.
UPDATE messages m
   SET status = 'delivered', error_reason = NULL
  FROM conversations c
 WHERE m.conversation_id = c.id
   AND c.god_synthetic = true
   AND c.contact_blocked = false
   AND m.direction = 'out'
   AND m.status = 'failed'
   AND m.error_reason ILIKE '%input entity%';
