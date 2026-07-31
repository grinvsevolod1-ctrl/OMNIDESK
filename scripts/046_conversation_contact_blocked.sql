-- Migration: contact-side block flag on conversations
-- Marks that the CLIENT (contact) has blocked our manager in the messenger.
-- Distinct from managers.status='blocked' (an employee account being blocked)
-- and from the lead status. Purely informational for the god console.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS contact_blocked BOOLEAN NOT NULL DEFAULT false;
