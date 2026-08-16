-- God-messenger read state.
-- `unread` on conversations counts what the MANAGER hasn't read (inbound
-- messages). The god messenger impersonates the CLIENT, so it needs its own
-- marker: messages FROM the manager (direction = 'out') created after
-- god_read_at are "unread by god" and light up the chat list.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS god_read_at timestamptz NOT NULL DEFAULT now();

-- Supports the per-conversation "count manager messages newer than X" lookup.
CREATE INDEX IF NOT EXISTS idx_messages_conv_dir_created
  ON messages (conversation_id, direction, created_at);
