-- Admin audit log — a durable trail of privileged God-panel actions.
--
-- Unlike ai_logs (a capped diagnostics ring-buffer), this is a real audit trail:
-- who (admin identity from the session), what (a stable action code), which
-- target (channel / conversation / manager id), and structured detail. It backs
-- accountability for the sensitive God-mode operations: deleting channels and
-- conversations, bulk-generating dialogs, hiding names, reassigning threads
-- between managers, and blocking/unblocking managers.
--
-- Append-only by convention; retention/trim is left to ops (a cron DELETE by
-- created_at) so history is preserved by default.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Session identity of the actor (admin). Not a FK: the admin account lives in
  -- env vars, not the managers table, so we store the id/name as captured.
  actor_id     text NOT NULL DEFAULT '',
  actor_name   text NOT NULL DEFAULT '',
  -- Stable machine code, e.g. 'channel.delete', 'conversation.reassign'.
  action       text NOT NULL,
  -- Optional target entity id the action affected (channel/conversation/manager).
  target_id    text,
  -- Optional human summary + structured extras (counts, from/to, statuses…).
  summary      text NOT NULL DEFAULT '',
  detail       jsonb
);

-- Newest-first browsing is the only access pattern for the log view.
CREATE INDEX IF NOT EXISTS idx_admin_audit_recent ON admin_audit_log(id DESC);
-- Filter by actor or action over time.
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action, id DESC);
