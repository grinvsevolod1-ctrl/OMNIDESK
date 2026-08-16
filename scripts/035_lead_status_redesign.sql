-- Lead status redesign + per-conversation first-contact timestamp.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/035_lead_status_redesign.sql
--
-- Safe to run on an existing database. It migrates the lead lifecycle from the
-- old set (new / in_progress / qualified / won / lost) to the new business
-- model and adds a reason sub-status for the "not liquid" bucket.
--
-- New status model (conversations.status):
--   * 'unsubscribed' -> «Отписок»   (default: everyone who ever wrote in)
--   * 'liquid'       -> «Ликвид»     (matches our target audience)
--   * 'not_liquid'   -> «Не ликвид»  (off-target; reason in status_detail)
--   * 'transferred'  -> «Передан»    (qualified & passed further)
-- status_detail (only when status = 'not_liquid'):
--   'geo' | 'under18' | 'na' | 'trash'

-- 1) Drop the old CHECK so we can remap values without violating it.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_status_check;

-- 2) Reason sub-status for «Не ликвид».
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS status_detail text;

-- 3) First-contact timestamp. conversations had no created_at; add one and
--    backfill it from the earliest message so "new in last 7 days" is accurate.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

UPDATE conversations c
   SET created_at = m.first_at
  FROM (
    SELECT conversation_id, MIN(created_at) AS first_at
      FROM messages
     GROUP BY conversation_id
  ) m
 WHERE m.conversation_id = c.id
   AND c.created_at > m.first_at;

-- 4) Remap existing statuses to the new model (per agreed mapping):
--    Новый/В работе → Отписок, Трудоустроен/Передан → Передан, Отказ → Не ликвид
UPDATE conversations SET status = 'unsubscribed'
 WHERE status IN ('new', 'in_progress');
UPDATE conversations SET status = 'transferred'
 WHERE status IN ('qualified', 'won');
UPDATE conversations SET status = 'not_liquid'
 WHERE status = 'lost';

-- 5) Re-add the CHECK with the new allowed values.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check
    CHECK (status IN ('unsubscribed', 'liquid', 'not_liquid', 'transferred'));

-- 6) Constrain status_detail to the known reasons (NULL allowed / required for
--    every status other than not_liquid).
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_status_detail_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_detail_check
    CHECK (
      status_detail IS NULL
      OR (status = 'not_liquid'
          AND status_detail IN ('geo', 'under18', 'na', 'trash'))
    );

-- Helpful index for first-contact analytics.
CREATE INDEX IF NOT EXISTS idx_conversations_created
  ON conversations (manager_id, created_at DESC);
