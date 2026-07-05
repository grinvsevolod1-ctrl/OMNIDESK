-- Manager "on lunch" availability + substitution routing.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/034_manager_lunch.sql
--
-- When a manager flips the "Я на обеде" toggle, NEW conversations that would
-- otherwise be created for them are instead routed (round-robin) to another
-- active manager who is NOT on lunch. Existing conversations are untouched —
-- they stay with whoever was already handling them. When the manager comes
-- back, new conversations flow to them again; substituted ones stay put.

-- Availability flag. Defaults to false (available). Idempotent.
ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS on_lunch BOOLEAN NOT NULL DEFAULT false;

-- Partial index so "who is available right now" stays cheap as the team grows.
CREATE INDEX IF NOT EXISTS idx_managers_available
  ON managers (id)
  WHERE status = 'active' AND on_lunch = false;

-- Reuse the generic atomic round-robin counter table (created in migration 011)
-- for the global lunch-substitute cursor. Seed the row so reads are stable.
INSERT INTO offhours_counters (name, n)
VALUES ('lunch_substitute', 0)
ON CONFLICT (name) DO NOTHING;
