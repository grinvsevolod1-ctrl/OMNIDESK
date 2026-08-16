-- Reversible "names glitch": when TRUE, the contact's real name is preserved in
-- contact_name but rendered as "NULL" in the app. Toggling the flag off restores
-- the original names instantly (nothing is destroyed).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS contact_name_hidden boolean NOT NULL DEFAULT false;
