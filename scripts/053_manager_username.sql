-- Add a login/username to managers so accounts can authenticate by either
-- their email OR a short login. The login defaults to the email's local part
-- (e.g. admin@site.com -> "admin"). Idempotent and safe to re-run.

ALTER TABLE managers ADD COLUMN IF NOT EXISTS username TEXT;

-- Backfill existing rows from the email local-part, de-duplicating collisions
-- (two managers whose emails share a local part) with a numeric suffix that is
-- stable per row (ordered by created_at, then id).
WITH derived AS (
  SELECT
    id,
    -- sanitize: lowercase, keep [a-z0-9._-], collapse everything else out
    NULLIF(
      regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g'),
      ''
    ) AS base
  FROM managers
  WHERE username IS NULL
),
numbered AS (
  SELECT
    id,
    COALESCE(base, 'user') AS base,
    row_number() OVER (
      PARTITION BY COALESCE(base, 'user')
      ORDER BY id
    ) AS rn
  FROM derived
)
UPDATE managers m
SET username = CASE
  WHEN n.rn = 1 THEN n.base
  ELSE n.base || '-' || n.rn
END
FROM numbered n
WHERE m.id = n.id;

-- Enforce case-insensitive uniqueness on the login going forward.
CREATE UNIQUE INDEX IF NOT EXISTS idx_managers_username
  ON managers (lower(username));
