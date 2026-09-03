-- 149: In-app notifications for curators (and any manager principal).
--
-- Used when the ADMIN returns a lead from the archive back to its curator:
-- the curator gets a modal notice on their overview explaining WHICH lead
-- came back and WHY (reason typed by the admin). Kept generic (kind/title/
-- body) so future in-app notices reuse the same table + curator modal.
--
-- recipient_id — always a real row in `managers` (curator); the root admin
-- (sub = 'admin') never receives notices, so no NULL principal is needed.
-- lead_card_id is nullable + ON DELETE CASCADE: if the lead is later purged,
-- the notice disappears with it instead of dangling.
CREATE TABLE IF NOT EXISTS lead_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id  UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  lead_card_id  UUID REFERENCES lead_cards (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  lead_name     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at       TIMESTAMPTZ
);

-- Curator modal polls unseen notices for one recipient, newest first.
CREATE INDEX IF NOT EXISTS lead_notifications_recipient_unseen_idx
  ON lead_notifications (recipient_id, created_at DESC)
  WHERE seen_at IS NULL;
