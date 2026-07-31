-- Defensive integrity constraints for values previously enforced only in code.
-- Added as NOT VALID first so legacy rows do not block deployment; new writes
-- are protected immediately. Clean legacy data, then VALIDATE in maintenance.

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_session_status_check;
ALTER TABLE channels ADD CONSTRAINT channels_session_status_check CHECK (
  session_status IN (
    'idle', 'starting', 'qr_pending', 'code_pending', 'password_pending',
    'online', 'offline', 'error', 'logged_out'
  )
) NOT VALID;

ALTER TABLE channel_jobs DROP CONSTRAINT IF EXISTS channel_jobs_action_check;
ALTER TABLE channel_jobs ADD CONSTRAINT channel_jobs_action_check CHECK (
  action IN (
    'start', 'stop', 'send_code', 'send_password', 'restart', 'logout',
    'send_message', 'request_qr'
  )
) NOT VALID;

ALTER TABLE channel_jobs DROP CONSTRAINT IF EXISTS channel_jobs_status_check;
ALTER TABLE channel_jobs ADD CONSTRAINT channel_jobs_status_check CHECK (
  status IN ('queued', 'running', 'done', 'error')
) NOT VALID;

ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_kind_check;
ALTER TABLE proxies ADD CONSTRAINT proxies_kind_check CHECK (
  kind IN ('socks5', 'http', 'mtproto')
) NOT VALID;

ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_status_check;
ALTER TABLE proxies ADD CONSTRAINT proxies_status_check CHECK (
  status IN ('unknown', 'ok', 'error')
) NOT VALID;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_unread_nonnegative;
ALTER TABLE conversations ADD CONSTRAINT conversations_unread_nonnegative
  CHECK (unread >= 0) NOT VALID;

ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_port_range;
ALTER TABLE proxies ADD CONSTRAINT proxies_port_range
  CHECK (port BETWEEN 1 AND 65535) NOT VALID;
