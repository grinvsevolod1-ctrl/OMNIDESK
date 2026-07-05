-- Omnidesk migration 024: store a contact's public @username separately.
--
-- Why: for Telegram (and WhatsApp business contacts) we key conversations by a
-- numeric/opaque handle and show the display name. The public @username was
-- only ever used as a *fallback* name when the contact had no first/last name,
-- so a manager juggling several accounts couldn't see "who" (@durov) a chat is
-- with when the contact also has a display name. We now persist the username in
-- its own column so the panel can show it alongside the name without losing the
-- addressing handle.
--
-- Additive and safe to run multiple times.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/024_contact_username.sql

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS contact_username text;
