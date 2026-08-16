-- Web Push subscriptions for the god-panel messenger (/wijegniwjgwjog/messages).
--
-- The god messenger is a single super-admin surface, not a per-manager one, so
-- (unlike push_subscriptions) there is no manager_id column — every row is just
-- a device the god-admin installed the messenger PWA on. Rows are keyed by the
-- browser push endpoint (unique), exactly like the manager/visitor tables, so a
-- re-subscribe from the same device refreshes in place instead of duplicating.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS god_push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
