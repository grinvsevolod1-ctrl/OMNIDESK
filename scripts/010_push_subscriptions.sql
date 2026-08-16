-- Web Push subscriptions for manager browser/mobile notifications.
--
-- Each row is one browser/device a manager has granted notification permission
-- on (a manager can have several: desktop + phone). The endpoint is the unique
-- push-service URL the browser gives us; p256dh + auth are the encryption keys
-- required by the Web Push protocol (VAPID).
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/010_push_subscriptions.sql

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id   UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_manager
  ON push_subscriptions (manager_id);
