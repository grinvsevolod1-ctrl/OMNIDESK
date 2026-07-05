-- Omnidesk: move proxies into an admin-managed pool (run after 003_engine.sql).
-- Proxies are now created by the admin and ASSIGNED to managers. A proxy may be
-- unassigned (manager_id IS NULL) while it sits in the pool. Live-chat channels
-- are likewise created by the admin and assigned to a manager (no schema change
-- needed there — channels.manager_id already points at the handling manager).
--
-- Safe to run multiple times.

-- 1. Allow proxies to exist without an owner (the admin pool).
ALTER TABLE proxies ALTER COLUMN manager_id DROP NOT NULL;

-- 2. Deleting a manager should NOT delete the admin's proxies; just unassign
--    them. Replace the original ON DELETE CASCADE FK with ON DELETE SET NULL.
DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT tc.constraint_name INTO fk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
  WHERE tc.table_name = 'proxies'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'manager_id';

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE proxies DROP CONSTRAINT %I', fk_name);
  END IF;

  ALTER TABLE proxies
    ADD CONSTRAINT proxies_manager_id_fkey
    FOREIGN KEY (manager_id) REFERENCES managers (id) ON DELETE SET NULL;
END$$;
