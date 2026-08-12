-- 128: close the race on livechat conversation creation.
--
-- recordLivechatInbound did SELECT-then-INSERT keyed by (channel_id,
-- contact_handle) with no unique constraint: two parallel first messages from
-- the same visitor could create TWO conversations, splitting the thread
-- between two managers.
--
-- Scope: livechat only. Other channel types (telegram/whatsapp/...) may
-- legitimately hold several historical conversations per handle, so the index
-- is partial. Pre-existing duplicates are merged into the most recent
-- conversation before the index is created (messages are moved, dupes
-- removed), which keeps the migration re-runnable and non-destructive.

DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT channel_id, contact_handle,
           (ARRAY_AGG(id ORDER BY last_message_at DESC))[1] AS keep_id,
           ARRAY_AGG(id ORDER BY last_message_at DESC) AS all_ids
      FROM conversations
     WHERE channel_type = 'livechat'
     GROUP BY channel_id, contact_handle
    HAVING COUNT(*) > 1
  LOOP
    -- Move every message from the duplicate conversations into the survivor.
    UPDATE messages
       SET conversation_id = dup.keep_id
     WHERE conversation_id = ANY(dup.all_ids)
       AND conversation_id <> dup.keep_id;
    -- Fold unread counters into the survivor, then drop the duplicates.
    UPDATE conversations
       SET unread = unread + COALESCE((
             SELECT SUM(unread) FROM conversations c2
              WHERE c2.id = ANY(dup.all_ids) AND c2.id <> dup.keep_id
           ), 0)
     WHERE id = dup.keep_id;
    DELETE FROM conversations
     WHERE id = ANY(dup.all_ids) AND id <> dup.keep_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_livechat_visitor_uniq
  ON conversations (channel_id, contact_handle)
  WHERE channel_type = 'livechat';
