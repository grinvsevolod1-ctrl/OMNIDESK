-- 129: Audit log for admin/manager/curator actions.
--
-- Records WHO did WHAT to WHICH entity, for accountability on a panel where
-- several people manage live client conversations and money-adjacent data.
-- Append-only by convention: the app only INSERTs and SELECTs; there is no
-- update/delete path. Retention is handled by the nightly retention cron.
--
-- NOTE: this table intentionally has NO writer in any god-panel code path.
-- The god console is invisible to every role including admin, so nothing it
-- does may ever surface here (see AGENTS.md section 4).

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'admin' | 'manager' | 'curator'
  actor_role TEXT NOT NULL,
  -- managers.id for manager/curator; NULL for the env-backed admin account.
  actor_id UUID,
  -- Human-readable actor label frozen at write time (name may change later).
  actor_label TEXT NOT NULL,
  -- Machine-readable action key, e.g. 'auth.login', 'lead.transfer',
  -- 'ai.settings.update', 'manager.block', 'account.password_change'.
  action TEXT NOT NULL,
  -- Entity kind + id the action touched, when applicable.
  entity_type TEXT,
  entity_id TEXT,
  -- Small JSON payload with the interesting details (old/new values, counts).
  -- Never store secrets or full message bodies here.
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor_role, actor_id, created_at DESC);
