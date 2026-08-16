-- 013_proxy_ownership.sql
-- Separate proxy OWNERSHIP from ASSIGNMENT so managers can bring their own
-- proxies without colliding with what the admin hands out.
--
--   created_by_role      who created the proxy ('admin' | 'manager')
--   created_by_manager_id the manager who created it (NULL for admin-created)
--
-- Existing rows predate self-service, so they are admin-owned by definition.
-- This migration is additive and idempotent; it never drops or rewrites the
-- credential columns, and channels.proxy_id keeps its ON DELETE SET NULL FK.

ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS created_by_role text NOT NULL DEFAULT 'admin',
  ADD COLUMN IF NOT EXISTS created_by_manager_id uuid;

-- Backfill: anything that already exists was created by the admin.
UPDATE proxies SET created_by_role = 'admin' WHERE created_by_role IS NULL;

-- A manager-created proxy is always owned by its creator; keep the column clean
-- for admin-created rows.
UPDATE proxies
   SET created_by_manager_id = NULL
 WHERE created_by_role = 'admin';

-- Constrain the role to known values (guarded so re-runs don't error).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proxies_created_by_role_chk'
  ) THEN
    ALTER TABLE proxies
      ADD CONSTRAINT proxies_created_by_role_chk
      CHECK (created_by_role IN ('admin', 'manager'));
  END IF;
END $$;

-- If a manager account is deleted, their self-created proxies go too.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proxies_created_by_manager_fk'
  ) THEN
    ALTER TABLE proxies
      ADD CONSTRAINT proxies_created_by_manager_fk
      FOREIGN KEY (created_by_manager_id) REFERENCES managers(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Fast lookups for "proxies this manager owns or is assigned".
CREATE INDEX IF NOT EXISTS idx_proxies_created_by_manager
  ON proxies (created_by_manager_id);
CREATE INDEX IF NOT EXISTS idx_proxies_manager
  ON proxies (manager_id);
