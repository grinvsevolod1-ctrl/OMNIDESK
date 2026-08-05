-- Omnidesk migration 108: proxy latency tracking + automatic failover support.
--
-- Backs the worker's periodic proxy health sweep:
--
--  1. proxies.latency_ms      — last measured round-trip of a successful probe
--                               (TCP tunnel to a real Telegram DC through the
--                               proxy). Lets the failover picker prefer the
--                               FASTEST live proxy instead of a random one.
--  2. proxies.last_checked_at — when the sweep last probed this proxy, so the
--                               panel can show freshness and the sweep can
--                               skip recently-checked rows.
--
-- Everything runs on the VPS itself: the worker probes through node:net —
-- no third-party services involved.
--
-- Safe to run multiple times (idempotent).
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/108_proxy_latency_and_failover.sql

ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS latency_ms integer,
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz;

-- The failover picker scans for free, healthy proxies of one manager — index
-- keeps that lookup cheap even with a large proxy pool.
CREATE INDEX IF NOT EXISTS idx_proxies_manager_status
  ON proxies (manager_id, status);
