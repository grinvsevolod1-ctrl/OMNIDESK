-- Lead statuses, messenger-transition tracking and conversion goals.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/012_leads_analytics.sql
--
-- This migration is additive and safe to run on an existing database. It does
-- NOT change how conversations/messages are created — it only enriches the
-- existing model so the panel can show lead analytics and track chat → messenger
-- transitions for the overview dashboards.

-- 1) Lead status on conversations (a "lead" is a conversation/contact that
--    wrote in). HYBRID model:
--      * status IS NULL  -> auto-derived from activity (unread>0 => "new",
--                           otherwise "in_progress"). No manual work required.
--      * status set      -> manual override pinned by a manager. Lets the team
--                           mark qualified / won / lost explicitly.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS status text
    CHECK (status IN ('new', 'in_progress', 'qualified', 'won', 'lost')),
  ADD COLUMN IF NOT EXISTS status_updated_at timestamptz;

-- 2) Raw chat → messenger transition events. Recorded when a website visitor
--    taps a Telegram/WhatsApp link on the off-hours screen of the live chat.
--    Kept as raw events (single source of truth); conversion goals are computed
--    on top of these rows so metrics stay consistent.
CREATE TABLE IF NOT EXISTS messenger_clicks (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Channel the click originated from. SET NULL (not cascade-delete) so historic
  -- analytics survive if the live-chat channel is later removed.
  channel_id UUID REFERENCES channels (id) ON DELETE SET NULL,
  messenger  TEXT NOT NULL CHECK (messenger IN ('telegram', 'whatsapp')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messenger_clicks_created
  ON messenger_clicks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messenger_clicks_channel
  ON messenger_clicks (channel_id);

-- 3) Conversion goals. A goal is a named definition that counts matching
--    messenger-transition events. messenger = 'any' counts every transition;
--    'telegram'/'whatsapp' count only that messenger.
CREATE TABLE IF NOT EXISTS conversion_goals (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  messenger  TEXT NOT NULL DEFAULT 'any'
             CHECK (messenger IN ('any', 'telegram', 'whatsapp')),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed two sensible default goals so the analytics page is populated out of the
-- box. Each insert is independent and idempotent.
INSERT INTO conversion_goals (name, messenger)
SELECT 'Переход в Telegram', 'telegram'
WHERE NOT EXISTS (
  SELECT 1 FROM conversion_goals WHERE messenger = 'telegram'
);

INSERT INTO conversion_goals (name, messenger)
SELECT 'Переход в WhatsApp', 'whatsapp'
WHERE NOT EXISTS (
  SELECT 1 FROM conversion_goals WHERE messenger = 'whatsapp'
);
