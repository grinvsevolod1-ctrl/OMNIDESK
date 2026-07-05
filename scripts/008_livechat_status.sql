-- Live-chat status + lifecycle hardening.
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/008_livechat_status.sql
--
-- Goals:
--   1. A live-chat channel is a standalone resource (one API key / one site).
--      Deleting the manager(s) behind it must NOT delete the channel — the chat
--      keeps existing and the widget keeps working (it just shows a "no agents
--      available" message until a manager is assigned again).
--   2. channels.status is the single source of truth for integration state:
--        pending   -> created in the admin, widget never connected yet
--        connected -> the widget has actually handshaked from the live site
--        error / disconnected -> reserved for future use
--      The pending -> connected transition is driven by the widget's SSE
--      handshake (see app/api/livechat/stream/route.ts -> markLivechatConnected).
--
-- Safe to run multiple times.

-- 1. A channel may outlive its owning manager (manager_id becomes NULL instead
--    of cascade-deleting the whole channel).
ALTER TABLE channels ALTER COLUMN manager_id DROP NOT NULL;

-- 2. Replace the original ON DELETE CASCADE FK with ON DELETE SET NULL so a
--    removed manager detaches from the channel rather than destroying it.
DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT tc.constraint_name INTO fk_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
  WHERE tc.table_name = 'channels'
    AND tc.constraint_type = 'FOREIGN KEY'
    AND kcu.column_name = 'manager_id';

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE channels DROP CONSTRAINT %I', fk_name);
  END IF;

  ALTER TABLE channels
    ADD CONSTRAINT channels_manager_id_fkey
    FOREIGN KEY (manager_id) REFERENCES managers (id) ON DELETE SET NULL;
END$$;

-- Note: conversations.manager_id keeps its ON DELETE CASCADE — a deleted
-- manager's individual conversations are removed with them, but the channel
-- (and its API key / install snippet) stays intact.
