-- Per-conversation mute flag. When true the conversation is silenced: no push
-- notifications, hidden from the default inbox list, and excluded from the
-- "awaiting reply" sorting and reminder nudges. Lets managers shut up abusive or
-- irrelevant contacts without deleting the thread.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false;

-- Partial index: the inbox almost always filters muted threads out, so only
-- index the muted rows we occasionally need to list explicitly.
CREATE INDEX IF NOT EXISTS conversations_muted_idx
  ON conversations (manager_id)
  WHERE muted;
