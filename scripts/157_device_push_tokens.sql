-- Native push device tokens for the Capacitor iOS/Android shell.
--
-- Web Push (push_subscriptions, migration 010) covers browsers and installed
-- PWAs, but Apple does NOT deliver Web Push inside a WKWebView — so the native
-- iOS shell needs real APNs, and Android uses FCM. Each row is one native
-- install of the app a manager/curator signed into, keyed by the device token
-- the OS hands the app. Routing is by `platform`: 'ios' -> APNs, 'android' -> FCM.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/157_device_push_tokens.sql

CREATE TABLE IF NOT EXISTS device_push_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id   UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  -- 'ios' | 'android'. Checked, not an enum, so adding a platform later
  -- (e.g. a desktop native shell) is a one-line change, not a type migration.
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  -- The APNs/FCM registration token. Unique so a re-register from the same
  -- install updates in place instead of duplicating deliveries.
  token        TEXT NOT NULL UNIQUE,
  -- App build that registered it, for diagnostics on the settings page.
  app_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_manager
  ON device_push_tokens (manager_id);
