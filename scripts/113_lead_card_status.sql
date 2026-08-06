-- 113_lead_card_status.sql
--
-- Curator workflow: daily status on each lead + comment history.
-- Statuses are confirmed per Moscow calendar day; after 10:00 MSK a lead
-- without today's confirmation blocks the curator workspace until filled.

ALTER TABLE lead_cards
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS previous_status TEXT,
  ADD COLUMN IF NOT EXISTS status_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_confirmed_date DATE;

-- Allowed status values (NULL = not yet set for the current day).
ALTER TABLE lead_cards DROP CONSTRAINT IF EXISTS lead_cards_status_check;
ALTER TABLE lead_cards
  ADD CONSTRAINT lead_cards_status_check
  CHECK (
    status IS NULL OR status IN (
      'awaiting_exit',
      'training',
      'working',
      'temporarily_off',
      'refused',
      'ignore',
      'left'
    )
  );

ALTER TABLE lead_cards DROP CONSTRAINT IF EXISTS lead_cards_previous_status_check;
ALTER TABLE lead_cards
  ADD CONSTRAINT lead_cards_previous_status_check
  CHECK (
    previous_status IS NULL OR previous_status IN (
      'awaiting_exit',
      'training',
      'working',
      'temporarily_off',
      'refused',
      'ignore',
      'left'
    )
  );

CREATE INDEX IF NOT EXISTS idx_lead_cards_status
  ON lead_cards (curator_id, status_confirmed_date)
  WHERE curator_id IS NOT NULL;

-- Comment log: every status change requires a comment (>= 30 chars enforced in app).
CREATE TABLE IF NOT EXISTS lead_card_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_card_id  UUID NOT NULL REFERENCES lead_cards (id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  status        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_card_comments_card
  ON lead_card_comments (lead_card_id, created_at DESC);
