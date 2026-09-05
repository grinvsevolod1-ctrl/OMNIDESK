-- 153: Self-sufficient god-created conversations.
--
-- Dialogs created from the god messenger address people who never wrote to the
-- account first, so Telegram has no cached access_hash for them and a real send
-- fails with "Could not find the input entity for PeerUser". Per the owner's
-- design these dialogs must behave like real, self-contained threads: an
-- outbound send ALWAYS settles as delivered WITHOUT touching Telegram — unless
-- the operator pressed "Заблокировать" on the dialog in the god messenger, in
-- which case the send settles as failed to mimic being blocked on the far side
-- (uses the existing conversations.contact_blocked flag, migration 046).
--
-- IMPORTANT (священный инвариант, см. AGENTS.md §4.3): this flag governs ONLY
-- send simulation. It is NEVER a visibility/analytics filter — god dialogs
-- remain ОБЫЧНЫЕ реальные диалоги everywhere else (inbox, analytics, lessons,
-- follow-up, curator/head views). Do NOT reuse it to hide or slice data.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS god_synthetic BOOLEAN NOT NULL DEFAULT false;
