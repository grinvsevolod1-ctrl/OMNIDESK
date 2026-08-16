-- Omnidesk integration engine schema (run after 001_schema.sql).
-- Adds: encrypted secrets, proxy pool, channel jobs queue, realtime NOTIFY.
-- Safe to run multiple times.

/* --------------------------- channels: extend --------------------------- */

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS phone           text,
  ADD COLUMN IF NOT EXISTS proxy_id        uuid,
  ADD COLUMN IF NOT EXISTS session_status  text NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS last_error      text,
  ADD COLUMN IF NOT EXISTS connected_at    timestamptz;

-- session_status lifecycle (worker-driven):
--   idle | starting | qr_pending | code_pending | password_pending |
--   online | offline | error | logged_out

/* ------------------------------- proxies -------------------------------- */

CREATE TABLE IF NOT EXISTS proxies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id  uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  label       text NOT NULL,
  kind        text NOT NULL DEFAULT 'socks5',           -- socks5 | http | mtproto
  host        text NOT NULL,
  port        integer NOT NULL,
  -- username/password are stored encrypted (AES-256-GCM envelope) or NULL
  username_enc text,
  password_enc text,
  -- mtproto secret (for telegram MTProto proxies), encrypted or NULL
  secret_enc  text,
  status      text NOT NULL DEFAULT 'unknown',          -- unknown | ok | error
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proxies_manager ON proxies(manager_id);

-- Link channels -> proxies (set null on proxy delete so the channel survives)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'channels_proxy_fk'
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_proxy_fk
      FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL;
  END IF;
END$$;

/* --------------------------- channel_secrets ---------------------------- */
-- One row per channel holding all encrypted credentials/session material.
-- Separated from channels so secrets are never selected by accident.

CREATE TABLE IF NOT EXISTS channel_secrets (
  channel_id  uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  -- Telegram MTProto: encrypted GramJS string session
  tg_session_enc   text,
  -- Telegram API credentials override (optional), encrypted
  tg_api_id_enc    text,
  tg_api_hash_enc  text,
  -- WhatsApp Baileys: encrypted multi-file auth state (JSON blob)
  wa_state_enc     text,
  -- Live-chat / generic API tokens, encrypted
  token_enc        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

/* ----------------------------- channel_jobs ----------------------------- */
-- Command queue: panel enqueues actions, worker consumes them.
-- Worker also writes results back into result/last_error.

CREATE TABLE IF NOT EXISTS channel_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  manager_id  uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  -- action: start | stop | send_code | send_password | restart | logout |
  --         send_message | request_qr
  action      text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'queued',           -- queued | running | done | error
  result      jsonb,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jobs_channel ON channel_jobs(channel_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON channel_jobs(status) WHERE status = 'queued';

/* ------------------------- realtime: NOTIFY hooks ------------------------ */
-- Worker LISTENs on 'channel_jobs' to pick up new commands instantly.
-- Panel LISTENs on 'realtime' to push SSE updates to the browser.

CREATE OR REPLACE FUNCTION notify_channel_jobs() RETURNS trigger AS $$
BEGIN
  IF (NEW.status = 'queued') THEN
    PERFORM pg_notify('channel_jobs', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_channel_jobs ON channel_jobs;
CREATE TRIGGER trg_notify_channel_jobs
  AFTER INSERT ON channel_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_channel_jobs();

-- Generic realtime fan-out for messages, conversations and channel status.
CREATE OR REPLACE FUNCTION notify_realtime() RETURNS trigger AS $$
DECLARE
  mid uuid;
  payload json;
BEGIN
  IF (TG_TABLE_NAME = 'messages') THEN
    SELECT c.manager_id INTO mid FROM conversations c WHERE c.id = NEW.conversation_id;
    payload := json_build_object(
      'type', 'message',
      'managerId', mid,
      'conversationId', NEW.conversation_id,
      'id', NEW.id
    );
  ELSIF (TG_TABLE_NAME = 'conversations') THEN
    payload := json_build_object(
      'type', 'conversation',
      'managerId', NEW.manager_id,
      'id', NEW.id
    );
  ELSIF (TG_TABLE_NAME = 'channels') THEN
    payload := json_build_object(
      'type', 'channel',
      'managerId', NEW.manager_id,
      'id', NEW.id,
      'status', NEW.status,
      'sessionStatus', NEW.session_status
    );
  END IF;
  PERFORM pg_notify('realtime', payload::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_realtime_messages ON messages;
CREATE TRIGGER trg_realtime_messages
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION notify_realtime();

DROP TRIGGER IF EXISTS trg_realtime_conversations ON conversations;
CREATE TRIGGER trg_realtime_conversations
  AFTER INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_realtime();

DROP TRIGGER IF EXISTS trg_realtime_channels ON channels;
CREATE TRIGGER trg_realtime_channels
  AFTER UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION notify_realtime();
