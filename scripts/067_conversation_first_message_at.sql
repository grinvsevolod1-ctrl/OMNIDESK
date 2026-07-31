-- Denormalize each conversation's FIRST message timestamp onto the row.
--
-- Problem: lead analytics ("new leads per day / this week", per-manager rollups)
-- computed "when did this contact first write in" with
--   JOIN messages ... GROUP BY conversation_id ... MIN(created_at)
-- on every dashboard load. That scans the whole messages table and grows with
-- message volume — the single most expensive part of the analytics queries.
--
-- Fix: store first_message_at on conversations and keep it maintained by a
-- trigger, so analytics reads a single indexed column instead of aggregating
-- messages. A trigger (rather than touching all ~11 message-insert call sites)
-- guarantees correctness no matter which code path inserts a message.
--
-- Additive and safe to run multiple times.

-- 1) The denormalized column.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMPTZ;

-- 2) Backfill existing rows from the current message history (one-time scan).
UPDATE conversations c
   SET first_message_at = sub.min_at
  FROM (
    SELECT conversation_id, MIN(created_at) AS min_at
      FROM messages
     GROUP BY conversation_id
  ) sub
 WHERE sub.conversation_id = c.id
   AND c.first_message_at IS NULL;

-- 3) Trigger to keep it maintained. On insert we only write when the value is
--    still NULL or the new message is actually earlier (out-of-order imports),
--    so for every message after the first the UPDATE matches zero rows and is
--    essentially free.
CREATE OR REPLACE FUNCTION set_conversation_first_message_at()
RETURNS trigger AS $$
BEGIN
  UPDATE conversations
     SET first_message_at =
           LEAST(COALESCE(first_message_at, NEW.created_at), NEW.created_at)
   WHERE id = NEW.conversation_id
     AND (first_message_at IS NULL OR first_message_at > NEW.created_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversation_first_message_at ON messages;
CREATE TRIGGER trg_conversation_first_message_at
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION set_conversation_first_message_at();

-- 4) Indexes powering the analytics reads. The composite index serves the
--    per-manager scoped queries; the plain one serves the system-wide (admin)
--    variants. Partial (NOT NULL) to skip message-less conversations.
CREATE INDEX IF NOT EXISTS idx_conversations_first_message_at
  ON conversations (first_message_at)
  WHERE first_message_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_mgr_first_message_at
  ON conversations (manager_id, first_message_at)
  WHERE first_message_at IS NOT NULL;
