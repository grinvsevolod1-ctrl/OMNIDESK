-- 077_fk_covering_indexes.sql
--
-- Add covering indexes for foreign-key columns that had none.
--
-- Why this matters: an un-indexed FK column forces a sequential scan of the
-- CHILD table every time a referenced PARENT row is deleted or updated (to
-- enforce ON DELETE CASCADE / SET NULL), and also makes any JOIN/filter on that
-- column slow. A static audit of all migrations (FK columns vs. existing leading
-- index columns) surfaced the seven columns below as uncovered.
--
-- Notes:
--  * The migration runner wraps each file in a transaction, so we CANNOT use
--    CREATE INDEX CONCURRENTLY here. These are plain CREATE INDEX statements and
--    take a brief lock while building. All target tables are small except
--    `messages`, where we build a PARTIAL index (only the rare manager-authored
--    rows), keeping the build fast and the index tiny.
--  * IF NOT EXISTS makes this migration safe to re-run.

-- channel_jobs.manager_id (NOT NULL, ON DELETE CASCADE): job queue can grow;
-- deleting a manager would otherwise seq-scan the whole queue.
CREATE INDEX IF NOT EXISTS channel_jobs_manager_id_idx
  ON channel_jobs (manager_id);

-- conversation_transfers.from_manager_id / to_manager_id (nullable, SET NULL):
-- both sides are looked up ("transfers by manager") and both are cascade
-- targets. Partial indexes skip the NULL rows that SET NULL leaves behind.
CREATE INDEX IF NOT EXISTS conversation_transfers_from_manager_id_idx
  ON conversation_transfers (from_manager_id)
  WHERE from_manager_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_transfers_to_manager_id_idx
  ON conversation_transfers (to_manager_id)
  WHERE to_manager_id IS NOT NULL;

-- message_edits.media_blob_id (nullable, SET NULL): deleting a media blob would
-- otherwise scan the full edit-history table.
CREATE INDEX IF NOT EXISTS message_edits_media_blob_id_idx
  ON message_edits (media_blob_id)
  WHERE media_blob_id IS NOT NULL;

-- messages.created_by_manager_id: this column does NOT exist on the `messages`
-- table (it lives on `proxies` only) -- no index created here.

-- sim_threads.channel_id (NOT NULL, ON DELETE CASCADE): simulator threads are
-- deleted when a channel is removed.
CREATE INDEX IF NOT EXISTS sim_threads_channel_id_idx
  ON sim_threads (channel_id);

-- telemost_meetings.conversation_id (nullable, SET NULL): meetings are looked up
-- by conversation, and cascade-nulled when a conversation is deleted.
CREATE INDEX IF NOT EXISTS telemost_meetings_conversation_id_idx
  ON telemost_meetings (conversation_id)
  WHERE conversation_id IS NOT NULL;
