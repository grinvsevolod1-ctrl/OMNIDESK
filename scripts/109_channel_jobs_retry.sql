-- Delayed-retry support for channel_jobs.
--
-- Motivation: a Telegram FLOOD_WAIT_<N> answer means "this exact request will
-- succeed after N seconds" — yet the worker treated every job error as
-- terminal, so a manager's message died with "не доставлено" over a wait as
-- short as 10 seconds. With these columns the worker can put the job back in
-- the queue with a not-before timestamp instead of failing it.
--
-- attempts   — how many times the job has been (re)claimed; caps the retry
--              loop so a permanently-flooded channel can't recycle a job
--              forever.
-- not_before — earliest claim time; NULL = immediately claimable (default,
--              matches all pre-existing rows).

ALTER TABLE channel_jobs ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE channel_jobs ADD COLUMN IF NOT EXISTS not_before timestamptz;

-- The queued-jobs index is claim-path critical; rebuild it to cover the
-- not_before ordering the claim query now uses.
DROP INDEX IF EXISTS idx_jobs_status;
CREATE INDEX IF NOT EXISTS idx_jobs_queued_claim
  ON channel_jobs(created_at)
  WHERE status = 'queued';
