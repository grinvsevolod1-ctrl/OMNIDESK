-- One-button Telegram QR login enqueues a channel_jobs row with
-- action = 'start_qr' (auth.exportLoginToken flow — no phone, no SMS).
-- The channel_jobs_action_check constraint must be re-asserted with the new
-- value, exactly like migrations 082 ('kick_foreign_sessions') and
-- 099 ('edit_message') did.
--
-- Keep this list in sync with the worker's switch in worker/src/registry.ts
-- and the JobAction union in lib/types.ts.
ALTER TABLE channel_jobs DROP CONSTRAINT IF EXISTS channel_jobs_action_check;
ALTER TABLE channel_jobs ADD CONSTRAINT channel_jobs_action_check CHECK (
  action IN (
    'start', 'start_qr', 'stop', 'restart', 'request_qr', 'logout',
    'pause', 'resume',
    'send_code', 'send_password',
    'send_message', 'forward_message', 'send_sticker',
    'mark_read', 'set_typing', 'react_message', 'delete_message',
    'edit_message',
    'kick_foreign_sessions'
  )
) NOT VALID;
