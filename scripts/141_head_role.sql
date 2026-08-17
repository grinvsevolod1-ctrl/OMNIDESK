-- 141_head_role.sql
--
-- New role «руководитель» (head): supervises a group of curators, sees their
-- leads and — when granted edit rights by the admin — can edit lead cards,
-- statuses, comments and transfer leads between the curators of their group.
--
-- Heads live in the same `managers` table (same auth/session machinery), like
-- curators did in 111_curator_role.sql. Differentiation is role = 'head'.

-- 1) Role domain: manager | curator | head ---------------------------------------
ALTER TABLE managers DROP CONSTRAINT IF EXISTS managers_role_check;
ALTER TABLE managers
  ADD CONSTRAINT managers_role_check
  CHECK (role IN ('manager', 'curator', 'head'));

-- Heads carry no city (like managers). Curators keep the required city.
ALTER TABLE managers DROP CONSTRAINT IF EXISTS managers_city_role_check;
ALTER TABLE managers
  ADD CONSTRAINT managers_city_role_check
  CHECK (
    (role = 'curator' AND city IS NOT NULL AND length(trim(city)) > 0)
    OR (role IN ('manager', 'head') AND city IS NULL)
  );

-- 2) Edit permission flag (meaningful only for role = 'head') --------------------
-- false = «только просмотр», true = «просмотр и редактирование».
ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS head_can_edit BOOLEAN NOT NULL DEFAULT false;

-- 3) Head -> curators mapping ------------------------------------------------------
-- A curator belongs to at most one head (UNIQUE on curator_id): keeps the
-- «head sees only their own curators» rule unambiguous.
CREATE TABLE IF NOT EXISTS head_curators (
  head_id    UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  curator_id UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (head_id, curator_id),
  CONSTRAINT head_curators_curator_unique UNIQUE (curator_id)
);

CREATE INDEX IF NOT EXISTS idx_head_curators_head ON head_curators (head_id);
