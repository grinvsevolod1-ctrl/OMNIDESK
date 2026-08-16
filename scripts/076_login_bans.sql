-- 076_login_bans.sql
--
-- Persistent brute-force blocklist for login.
--
-- The in-memory rate limiter (lib/rate-limit.ts) stays the fast, synchronous
-- first line of defence on the hot path. Its one weakness is that its counters
-- live in process memory, so a `pm2 restart` (every deploy) wipes them — a
-- determined attacker could reset their budget by waiting for a deploy.
--
-- This table is the durable second layer, used ONLY on the login path (which is
-- already async and not latency-sensitive): once an identifier trips the
-- in-memory limit it gets a ban row here with an escalating `blocked_until`, so
-- the block survives restarts and redeploys. Public hot paths (livechat) are
-- untouched and pay no extra DB round-trip.

CREATE TABLE IF NOT EXISTS login_bans (
  -- Ban key, e.g. "ip:1.2.3.4" or "id:someone@example.com" (lower-cased).
  key           text PRIMARY KEY,
  -- How many times this key has tripped the limit. Drives escalating backoff.
  strikes       integer NOT NULL DEFAULT 1,
  -- The ban is active until this instant. NULL is never stored (always set).
  blocked_until timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Lets the cleanup sweep find and drop expired bans cheaply.
CREATE INDEX IF NOT EXISTS login_bans_blocked_until_idx
  ON login_bans (blocked_until);
