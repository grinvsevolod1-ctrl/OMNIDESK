-- Conversation hand-off between managers.
--
-- A manager going offline (or simply needing help) can transfer an open
-- conversation to a colleague. The conversation itself just moves via
-- conversations.manager_id; this table keeps an audit trail of who handed what
-- to whom, so the history survives even after either manager is deleted.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS conversation_transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- Managers may be deleted; keep the audit row but null the reference.
  from_manager_id UUID REFERENCES managers (id) ON DELETE SET NULL,
  to_manager_id   UUID REFERENCES managers (id) ON DELETE SET NULL,
  -- Free-text handover note the sender optionally leaves for the receiver.
  note            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast "what was transferred to me / by me" lookups.
CREATE INDEX IF NOT EXISTS conversation_transfers_to_idx
  ON conversation_transfers (to_manager_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversation_transfers_conv_idx
  ON conversation_transfers (conversation_id, created_at DESC);
