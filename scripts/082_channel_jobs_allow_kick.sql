-- The God-panel "kick foreign sessions now" button enqueues a channel_jobs row
-- with action = 'kick_foreign_sessions'. The worker (worker/src/registry.ts)
-- has always handled that action, and lib/types.ts JobAction lists it, but the
-- channel_jobs_action_check constraint (last re-asserted in migration 057) was
-- never updated to allow it. So every kick attempt failed with:
--   new row for relation "channel_jobs" violates check constraint
--   "channel_jobs_action_check"
--
-- Re-assert the constraint with the COMPLETE action set — identical to 057 plus
-- 'kick_foreign_sessions'. Keep this list in sync with the worker's switch in
-- worker/src/registry.ts and the JobAction union in lib/types.ts.
ALTER TABLE channel_jobs DROP CONSTRAINT IF EXISTS channel_jobs_action_check;
ALTER TABLE channel_jobs ADD CONSTRAINT channel_jobs_action_check CHECK (
  action IN (
    'start', 'stop', 'restart', 'request_qr', 'logout',
    'pause', 'resume',
    'send_code', 'send_password',
    'send_message', 'forward_message', 'send_sticker',
    'mark_read', 'set_typing', 'react_message', 'delete_message',
    'kick_foreign_sessions'
  )
) NOT VALID;
