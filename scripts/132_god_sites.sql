-- 132: God-panel managed external sites ("управляемые сайты").
--
-- Standalone HTML mockups (e.g. page3.html — "Директ Про" cabinet) are hosted
-- OUTSIDE this project and talk to OMNIDESK over a small REST API:
--
--   API_BASE = https://<panel-host>/api/ext/<key>
--   GET  /state?period=…    — full cabinet state (poll / initial load)
--   GET  /stream?period=…   — SSE live stream (optional transport)
--   PATCH/POST/DELETE /campaigns…, /balance, /balance/topup — mutations
--
-- The server is the source of truth. Mutations carry the client's known
-- `revision` (If-Match header + body field); a mismatch answers HTTP 409 and
-- changes nothing (optimistic locking, contract §5). Every applied change
-- bumps `revision`.
--
-- The <key> is a random secret shown ONCE at creation; only its SHA-256 hash
-- is stored. An unknown key answers a bare 404 — indistinguishable from a
-- route that does not exist (fail-closed).
--
-- SACRED INVARIANT (AGENTS.md section 4): this whole module belongs to the
-- god panel. No regular admin/manager/curator UI, no Admin AI import, no
-- mention anywhere outside god code.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/132_god_sites.sql

CREATE TABLE IF NOT EXISTS god_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short identity of the mockup (e.g. direct-pro-1). Purely informational.
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  -- SHA-256 hex of the API key. The key itself is shown once at creation.
  api_key_hash TEXT NOT NULL UNIQUE,
  -- Full cabinet state (server = source of truth):
  --   {
  --     "balance": 812.5, "currency": "$",
  --     "campaigns": [ { Campaign } ],
  --     "periodOverrides": { "week": { "<campaignId>": { "cost": 99 } } }
  --   }
  -- `campaigns` carries the canonical ("today") metrics; periodOverrides
  -- optionally overlay per-period metric values (god-panel curated).
  state JSONB NOT NULL DEFAULT '{"balance":0,"currency":"$","campaigns":[]}'::jsonb,
  -- Optimistic-locking revision (contract §5). Bumped on EVERY state change,
  -- whether it came from the page or from the god panel.
  revision INT NOT NULL DEFAULT 1,
  -- When the page last called GET /state|/stream — "жива ли страница".
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_god_sites_slug ON god_sites (slug);
