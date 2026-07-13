-- Two self-healing fixes, both safe to run on every instance.
--
-- 1) channel_jobs.action CHECK was stale: it only listed a handful of actions
--    (start/stop/send_code/send_password/restart/logout/send_message/request_qr)
--    but the worker (worker/src/registry.ts) also dispatches mark_read,
--    set_typing, react_message, delete_message, forward_message, send_sticker,
--    pause and resume. Enqueuing any of those hit
--    "channel_jobs_action_check" violations. Re-assert the constraint with the
--    COMPLETE action set so it matches the worker's switch exactly.
--
-- 2) sim_settings.dialogs_per_day: migration 055 adds this column, but the
--    migrate runner records migrations by filename and never retries one it has
--    already logged as applied. On any instance where 055 was recorded but the
--    column didn't actually land (e.g. applied against a different database),
--    re-running `db:migrate` would never re-add it. Re-adding it here — from a
--    NEW migration the runner has not seen — self-heals every such instance.
--    ADD COLUMN IF NOT EXISTS is a no-op where the column already exists.

-- 1) Complete channel_jobs action set (keep in sync with registry.ts).
ALTER TABLE channel_jobs DROP CONSTRAINT IF EXISTS channel_jobs_action_check;
ALTER TABLE channel_jobs ADD CONSTRAINT channel_jobs_action_check CHECK (
  action IN (
    'start', 'stop', 'restart', 'request_qr', 'logout',
    'pause', 'resume',
    'send_code', 'send_password',
    'send_message', 'forward_message', 'send_sticker',
    'mark_read', 'set_typing', 'react_message', 'delete_message'
  )
) NOT VALID;

-- 2) Self-heal the client-simulator throughput column (idempotent).
ALTER TABLE sim_settings
  ADD COLUMN IF NOT EXISTS dialogs_per_day integer NOT NULL DEFAULT 20;
