-- Manager-side message editing (Telegram-style) enqueues a channel_jobs row
-- with action = 'edit_message' so the worker applies the edit in Telegram and
-- the contact sees the native "edited" mark. The worker handles the action
-- (worker/src/registry.ts) and lib/types.ts JobAction lists it, but the
-- channel_jobs_action_check constraint must be re-asserted with the new value,
-- exactly like migration 082 did for 'kick_foreign_sessions'.
--
-- Keep this list in sync with the worker's switch in worker/src/registry.ts
-- and the JobAction union in lib/types.ts.
ALTER TABLE channel_jobs DROP CONSTRAINT IF EXISTS channel_jobs_action_check;
ALTER TABLE channel_jobs ADD CONSTRAINT channel_jobs_action_check CHECK (
  action IN (
    'start', 'stop', 'restart', 'request_qr', 'logout',
    'pause', 'resume',
    'send_code', 'send_password',
    'send_message', 'forward_message', 'send_sticker',
    'mark_read', 'set_typing', 'react_message', 'delete_message',
    'edit_message',
    'kick_foreign_sessions'
  )
) NOT VALID;
