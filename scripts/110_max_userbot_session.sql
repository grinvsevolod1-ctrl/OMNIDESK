-- MAX userbot (account) session storage.
--
-- Until now the only MAX mode was the official Bot API: inbound over a webhook
-- handled inside Next.js, no worker session (see scripts/032). This migration
-- adds the ACCOUNT mode — a personal MAX account driven over MAX's unofficial
-- WebSocket protocol (wss://ws-api.oneme.ru), exactly analogous to how the
-- Telegram userbot runs in the worker.
--
-- The two modes are distinguished at runtime by channels.config.mode:
--   'bot'     -> existing Bot API path (Next.js), no worker session
--   'account' -> new userbot path (worker holds a live socket)
-- No new channel *type* is introduced: MAX stays type='max'.
--
-- Session material (the MAX auth token returned after SMS login) is stored
-- ENCRYPTED with AES-256-GCM via lib/crypto, in a dedicated column beside the
-- Telegram session so secrets are never selected by accident.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/110_max_userbot_session.sql

ALTER TABLE channel_secrets
  ADD COLUMN IF NOT EXISTS max_session_enc text;

-- Fast lookup for the worker's live/revival sweeps: "MAX account channels that
-- have a saved session". Partial index keeps it tiny (only account-mode MAX
-- rows ever populate max_session_enc).
CREATE INDEX IF NOT EXISTS idx_channel_secrets_max_session
  ON channel_secrets (channel_id)
  WHERE max_session_enc IS NOT NULL;
