-- 115_curator_cities_and_history.sql
--
-- Curator model evolution:
-- 1) cities dictionary — canonical city names, so «Москва» / «москва » /
--    «МОСКВА» stop being three different cities. Lookup key is a normalized
--    (lower + collapsed spaces) form.
-- 2) curator_cities — a curator may cover multiple cities. managers.city stays
--    as the primary/display city; matching goes through curator_cities.
-- 3) lead_status_history — full status trail (previous_status keeps only one
--    step; this table keeps them all, including resets on transfer).
-- 4) pg_trgm indexes for fast substring city search (LIKE '%q%').

-- 1) Cities dictionary ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS cities (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical display name («Москва»), first-writer wins.
  name       TEXT NOT NULL,
  -- Normalized lookup key: lower(name) with collapsed whitespace.
  name_norm  TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed from every city already present in managers and lead_cards.
INSERT INTO cities (name, name_norm)
SELECT DISTINCT ON (norm) trim(regexp_replace(src.city, '\s+', ' ', 'g')) AS name,
       lower(trim(regexp_replace(src.city, '\s+', ' ', 'g'))) AS norm
  FROM (
    SELECT city FROM managers WHERE city IS NOT NULL AND btrim(city) <> ''
    UNION ALL
    SELECT city FROM lead_cards WHERE city IS NOT NULL AND btrim(city) <> ''
  ) AS src
 ORDER BY norm, name
ON CONFLICT (name_norm) DO NOTHING;

-- 2) Curator cities (many per curator) ------------------------------------------
CREATE TABLE IF NOT EXISTS curator_cities (
  curator_id UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  city       TEXT NOT NULL,
  city_norm  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (curator_id, city_norm)
);

CREATE INDEX IF NOT EXISTS idx_curator_cities_norm ON curator_cities (city_norm);

-- Backfill from the single-city column.
INSERT INTO curator_cities (curator_id, city, city_norm)
SELECT id,
       trim(regexp_replace(city, '\s+', ' ', 'g')),
       lower(trim(regexp_replace(city, '\s+', ' ', 'g')))
  FROM managers
 WHERE role = 'curator' AND city IS NOT NULL AND btrim(city) <> ''
ON CONFLICT (curator_id, city_norm) DO NOTHING;

-- 3) Full status history ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_status_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_card_id  UUID NOT NULL REFERENCES lead_cards (id) ON DELETE CASCADE,
  curator_id    UUID REFERENCES managers (id) ON DELETE SET NULL,
  -- Snapshot survives account deletion.
  curator_name  TEXT,
  -- NULL status = reset (e.g. the lead was transferred to another curator).
  status        TEXT,
  reason        TEXT NOT NULL DEFAULT 'confirm', -- 'confirm' | 'transfer_reset'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_status_history_card
  ON lead_status_history (lead_card_id, created_at DESC);

-- Backfill from status comments (they carry the confirmed status + author).
INSERT INTO lead_status_history (lead_card_id, curator_id, curator_name, status, reason, created_at)
SELECT c.lead_card_id, c.author_id,
       COALESCE(m.name, c.author_name),
       c.status, 'confirm', c.created_at
  FROM lead_card_comments c
  LEFT JOIN managers m ON m.id = c.author_id
 WHERE c.status IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM lead_status_history h WHERE h.lead_card_id = c.lead_card_id);

-- 4) Trigram indexes for substring city search -----------------------------------
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS idx_managers_city_trgm
    ON managers USING gin (lower(city) gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_lead_cards_city_trgm
    ON lead_cards USING gin (lower(city) gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS idx_curator_cities_trgm
    ON curator_cities USING gin (city_norm gin_trgm_ops);
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pg_trgm unavailable (no privilege) — substring search stays unindexed';
END $$;
