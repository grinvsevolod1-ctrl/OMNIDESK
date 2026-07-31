-- 081_channel_jobs_nullable_manager.sql
--
-- The God-panel can enqueue channel jobs (e.g. `kick_foreign_sessions`) that are
-- initiated by the env-backed super-admin, which is NOT a row in `managers`.
-- Such jobs are system/admin-initiated and legitimately have no owning manager,
-- so `channel_jobs.manager_id` must be nullable. When a targeted channel HAS an
-- owner we still attribute the job to that manager; only owner-less (orphaned)
-- channels record a NULL manager_id. The FK to managers(id) is preserved for
-- non-NULL values.
--
-- Idempotent: DROP NOT NULL is a no-op if the column is already nullable.

ALTER TABLE channel_jobs ALTER COLUMN manager_id DROP NOT NULL;
