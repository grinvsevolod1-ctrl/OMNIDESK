-- 014_session_invalidation.sql
-- Server-side session invalidation for managers.
--
-- Sessions are stateless JWTs that live for 7 days. Without a way to revoke
-- them, changing a manager's password (or blocking them) left every already
-- issued token valid until natural expiry. This migration adds a monotonic
-- `session_version` counter to each manager: it is embedded into the JWT at
-- login and re-checked on every request. Bumping it (on password reset, self
-- password change, or block) instantly invalidates all outstanding sessions.
--
-- Additive and idempotent — safe to run multiple times.
--   Run on your VPS:  psql "$DATABASE_URL" -f scripts/014_session_invalidation.sql

ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
