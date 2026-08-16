-- 126: DB-level idempotency for outbound send jobs.
--
-- WHY: a send_message job carries payload.messageId (the app-side message row
-- it delivers). Until now nothing stopped TWO live jobs for the same message
-- from coexisting — a double-click on "send", a server action retry, or an
-- HTTP retry after a timeout each enqueue again, and the client receives the
-- same message twice. Code-level guards can't close this race (two inserts
-- can pass the same check concurrently); only a unique index can.
--
-- Scope: only LIVE jobs (queued/running) — once a job is done or errored, a
-- deliberate manual retry for the same message stays possible. Non-send jobs
-- and sends without a messageId (none today) are unaffected.
--
-- Cleanup first: if history already contains overlapping live duplicates
-- (worker downtime + repeated clicks), keep the oldest of each group and
-- cancel the rest so the index can build.
WITH dupes AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY (payload->>'messageId')
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM channel_jobs
   WHERE action = 'send_message'
     AND status IN ('queued', 'running')
     AND payload->>'messageId' IS NOT NULL
)
UPDATE channel_jobs
   SET status = 'error',
       last_error = 'superseded: duplicate live send job for the same message (126 cleanup)',
       updated_at = now()
 WHERE id IN (SELECT id FROM dupes WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_jobs_live_send_per_message
  ON channel_jobs ((payload->>'messageId'))
  WHERE action = 'send_message'
    AND status IN ('queued', 'running')
    AND (payload->>'messageId') IS NOT NULL;
