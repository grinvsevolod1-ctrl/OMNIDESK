-- 112_lead_cards.sql
--
-- Lead cards filled by managers/admins and transferred to curators by city.
-- One card per conversation (upsert). transferred_at is set when a curator
-- is chosen; the curator then sees the card in their lead list.

CREATE TABLE IF NOT EXISTS lead_cards (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    UUID REFERENCES conversations (id) ON DELETE SET NULL,
  -- Manager (or admin acting as filler) who created/last updated the card.
  manager_id         UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  -- Curator who received the lead (null until transferred).
  curator_id         UUID REFERENCES managers (id) ON DELETE SET NULL,
  full_name          TEXT NOT NULL DEFAULT '',
  phone              TEXT NOT NULL DEFAULT '',
  telegram_username  TEXT NOT NULL DEFAULT '',
  city               TEXT NOT NULL DEFAULT '',
  address            TEXT NOT NULL DEFAULT '',
  vacancy            TEXT NOT NULL DEFAULT '',
  transferred_at     TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one card per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_cards_conversation
  ON lead_cards (conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lead_cards_curator
  ON lead_cards (curator_id, transferred_at DESC NULLS LAST)
  WHERE curator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lead_cards_manager
  ON lead_cards (manager_id, updated_at DESC);
