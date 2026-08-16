-- Track WHEN a channel's session_status last changed (not merely re-asserted).
--
-- Purpose: the manager inbox shows an "account needs attention" banner for
-- degraded personal accounts. Reconnects usually recover in seconds, so the
-- banner was pure noise for managers. With this timestamp the panel can apply
-- a grace period: only surface accounts that have been degraded for 5+ minutes.
--
-- The worker re-asserts the same status frequently (every health sweep), so
-- the column must only move when the VALUE actually changes — enforced by a
-- trigger rather than trusting every writer to remember the CASE expression.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS session_status_changed_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION touch_session_status_changed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.session_status IS DISTINCT FROM OLD.session_status THEN
    NEW.session_status_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_session_status_changed_at ON channels;
CREATE TRIGGER trg_touch_session_status_changed_at
  BEFORE UPDATE OF session_status ON channels
  FOR EACH ROW
  EXECUTE FUNCTION touch_session_status_changed_at();
