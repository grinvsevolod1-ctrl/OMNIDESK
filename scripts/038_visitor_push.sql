-- Web Push subscriptions for WEBSITE VISITORS (not managers).
--
-- The live-chat widget runs on the customer's own domain, where we cannot
-- subscribe a visitor to OUR push notifications (Service Workers + Web Push are
-- same-origin only). So a small page on our domain (/c/<apiKey>) handles the
-- install + subscription and stores the result here, keyed by the same visitor
-- id (contact_handle) the widget uses. When a manager replies we look the
-- visitor up by (channel_id, contact_handle) and push the reply — so a visitor
-- who left the page still gets notified and is brought back into the chat.
--
-- Mirrors push_subscriptions (managers) but scoped to a channel + visitor handle
-- instead of a manager id. Standalone table so the two never interfere.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/038_visitor_push.sql
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS visitor_push_subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     UUID NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  contact_handle TEXT NOT NULL,
  endpoint       TEXT NOT NULL UNIQUE,
  p256dh         TEXT NOT NULL,
  auth           TEXT NOT NULL,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_visitor_push_channel_handle
  ON visitor_push_subscriptions (channel_id, contact_handle);
