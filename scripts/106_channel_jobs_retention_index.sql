-- 106: Partial index backing the channel_jobs retention sweep.
--
-- The worker now purges finished jobs older than 7 days (see
-- purgeFinishedChannelJobs). Voice-note jobs carry the full audio as base64
-- in their payload (~0.4 MB each), so the table used to grow without bound.
-- This partial index keeps the daily DELETE from scanning live rows: only
-- finished jobs are indexed, ordered by age.

CREATE INDEX IF NOT EXISTS idx_channel_jobs_finished_age
  ON channel_jobs (updated_at)
  WHERE status IN ('done', 'error');
