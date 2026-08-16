-- Omnidesk schema for self-hosted PostgreSQL.
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/001_schema.sql
--
-- The admin account is NOT stored here; it is configured via ADMIN_EMAIL /
-- ADMIN_PASSWORD environment variables. Only managers and their data live in DB.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Managers ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS managers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'blocked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_managers_email ON managers (lower(email));

-- Channels ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id      UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  type            TEXT NOT NULL
                  CHECK (type IN ('telegram', 'whatsapp', 'livechat')),
  name            TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('connected', 'pending', 'error', 'disconnected')),
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_channels_manager ON channels (manager_id);

-- Conversations -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  manager_id      UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  channel_type    TEXT NOT NULL,
  contact_name    TEXT NOT NULL DEFAULT 'Unknown',
  contact_handle  TEXT NOT NULL DEFAULT '',
  last_message    TEXT NOT NULL DEFAULT '',
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unread          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversations_manager
  ON conversations (manager_id, last_message_at DESC);

-- Messages ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body            TEXT NOT NULL,
  author          TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at ASC);
