-- 111_curator_role.sql
--
-- Introduce the «куратор» (curator) role as a third identity alongside admin
-- (env-backed) and manager (DB). Curators live in the same `managers` table so
-- they reuse the existing auth, session_version, status and password machinery
-- without duplicating tables. Differentiation is a `role` column; curators also
-- carry a required `city` — the city they are responsible for.
--
-- Existing rows are backfilled as role = 'manager' with city = NULL.

ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'manager',
  ADD COLUMN IF NOT EXISTS city TEXT;

-- Tighten the role domain. DROP + ADD is safe: every existing row is 'manager'.
ALTER TABLE managers DROP CONSTRAINT IF EXISTS managers_role_check;
ALTER TABLE managers
  ADD CONSTRAINT managers_role_check
  CHECK (role IN ('manager', 'curator'));

-- Curators must have a non-empty city; managers must not carry one.
ALTER TABLE managers DROP CONSTRAINT IF EXISTS managers_city_role_check;
ALTER TABLE managers
  ADD CONSTRAINT managers_city_role_check
  CHECK (
    (role = 'curator' AND city IS NOT NULL AND length(trim(city)) > 0)
    OR (role = 'manager' AND city IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_managers_role ON managers (role);
CREATE INDEX IF NOT EXISTS idx_managers_city ON managers (lower(city))
  WHERE role = 'curator';
