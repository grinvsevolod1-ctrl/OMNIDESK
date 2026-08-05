-- 104: Manual-stop flag for channels.
--
-- Problem this fixes: an admin pressing "Stop" set session_status='offline'
-- while the saved session string remained — which is EXACTLY the state the
-- auto-revival sweep treats as "degraded, reconnect me". The account came back
-- online ~60 seconds after being deliberately stopped.
--
-- The worker sets this flag on a 'stop' job and clears it on any explicit
-- start ('start' / 'start_qr' / 'restart'). Both the revival sweep and the
-- startup restore exclude channels where it is set, so a manual stop now
-- sticks until a human starts the channel again.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS manually_stopped boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN channels.manually_stopped IS
  'True after an explicit stop job: excludes the channel from auto-revival and startup restore until an explicit start clears it.';
