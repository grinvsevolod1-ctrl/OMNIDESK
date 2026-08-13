-- 132: God-panel managed external sites ("управляемые сайты").
--
-- Standalone HTML pages (presentation mockups) embed a polling API client and
-- pull state/commands from this panel:  GET /api/ext/<key>/state  every N ms.
-- The page can also POST its current state back so the panel always sees live
-- data. The key is a random secret shown ONCE at creation; only its SHA-256
-- hash is stored here.
--
-- SACRED INVARIANT (AGENTS.md section 4): this whole module belongs to the
-- god panel. No regular admin/manager/curator UI, no Admin AI import, no
-- mention anywhere outside god code. The public /api/ext route answers a bare
-- 404 for unknown keys — indistinguishable from a nonexistent route.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/132_god_sites.sql

CREATE TABLE IF NOT EXISTS god_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The mockup "login" identity (e.g. porg-zvuq2cjx). Channel and storage keys
  -- on the page derive from it (yd-<slug>, ydState_<slug>).
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  -- SHA-256 hex of the API key. The key itself is shown once at creation.
  api_key_hash TEXT NOT NULL UNIQUE,
  -- Last known full state of the page (balance/campaigns/notifications...).
  -- Written by the page's POST-back and by panel-side edits.
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Pending command queue for the polling channel. Each element:
  --   { "action": "setBalance", "args": [950] }
  -- GET drains the queue atomically (returns {commands:[...]} and clears it).
  commands JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Bumped on every state change (panel UI freshness/polling hints).
  state_version INT NOT NULL DEFAULT 1,
  -- When the page last reported its state (POST-back) — "жива ли страница".
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_god_sites_slug ON god_sites (slug);
