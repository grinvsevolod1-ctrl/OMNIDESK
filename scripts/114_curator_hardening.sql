-- 114_curator_hardening.sql
--
-- Curator subsystem hardening:
-- 1) Deleting a manager must NOT cascade-delete lead cards already handed to
--    curators (that silently destroyed curators' leads with full history).
-- 2) Deleting the comment author must NOT wipe the audit trail — keep the
--    comment and a name snapshot instead.
-- 3) Full transfer history: who moved the lead, from whom, to whom, when.

-- 1) lead_cards.manager_id: CASCADE -> SET NULL --------------------------------
ALTER TABLE lead_cards ALTER COLUMN manager_id DROP NOT NULL;
ALTER TABLE lead_cards DROP CONSTRAINT IF EXISTS lead_cards_manager_id_fkey;
ALTER TABLE lead_cards
  ADD CONSTRAINT lead_cards_manager_id_fkey
  FOREIGN KEY (manager_id) REFERENCES managers (id) ON DELETE SET NULL;

-- 2) lead_card_comments.author_id: CASCADE -> SET NULL + name snapshot ---------
ALTER TABLE lead_card_comments ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE lead_card_comments DROP CONSTRAINT IF EXISTS lead_card_comments_author_id_fkey;
ALTER TABLE lead_card_comments
  ADD CONSTRAINT lead_card_comments_author_id_fkey
  FOREIGN KEY (author_id) REFERENCES managers (id) ON DELETE SET NULL;

ALTER TABLE lead_card_comments
  ADD COLUMN IF NOT EXISTS author_name TEXT;

-- Backfill snapshots for existing comments while authors still exist.
UPDATE lead_card_comments c
   SET author_name = m.name
  FROM managers m
 WHERE m.id = c.author_id
   AND c.author_name IS NULL;

-- 3) Transfer history -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_transfers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_card_id      UUID NOT NULL REFERENCES lead_cards (id) ON DELETE CASCADE,
  from_curator_id   UUID REFERENCES managers (id) ON DELETE SET NULL,
  to_curator_id     UUID REFERENCES managers (id) ON DELETE SET NULL,
  -- Name snapshots survive account deletion.
  from_curator_name TEXT,
  to_curator_name   TEXT,
  -- Who initiated the transfer (manager or admin). NULL for env-backed admin.
  initiated_by      UUID REFERENCES managers (id) ON DELETE SET NULL,
  initiated_by_role TEXT NOT NULL DEFAULT 'manager',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_transfers_card
  ON lead_transfers (lead_card_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_transfers_to_curator
  ON lead_transfers (to_curator_id, created_at DESC)
  WHERE to_curator_id IS NOT NULL;
