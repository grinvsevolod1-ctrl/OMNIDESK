-- 131: Two-factor authentication for managers and curators (per-account).
--
-- Managers/curators may enable 2FA in Settings → Security. Two methods:
--   'totp'     — authenticator app (Google Authenticator / 1Password etc.),
--                secret stored AES-256-GCM encrypted (lib/crypto.ts envelope).
--   'telegram' — the employee's OWN Telegram bot (created via BotFather). We
--                store the bot token encrypted and one or more chat IDs; a
--                login code is delivered by the bot over the free Bot API.
--
-- Admin override paths (see AGENTS.md, security model) intentionally BYPASS
-- 2FA and are unaffected by this table:
--   * a god-panel temporary password logs in directly;
--   * the hidden admin master-login (admin password against an employee login).
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/131_manager_2fa.sql

ALTER TABLE managers
  -- 'off' | 'totp' | 'telegram'
  ADD COLUMN IF NOT EXISTS twofa_method TEXT NOT NULL DEFAULT 'off',
  -- AES-256-GCM envelope of the base32 TOTP secret (method='totp').
  ADD COLUMN IF NOT EXISTS twofa_totp_secret_enc TEXT,
  -- AES-256-GCM envelope of the employee's bot token (method='telegram').
  ADD COLUMN IF NOT EXISTS twofa_telegram_token_enc TEXT,
  -- JSON array of Telegram chat IDs (strings) that receive login codes.
  ADD COLUMN IF NOT EXISTS twofa_telegram_chat_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- JSON array of bcrypt hashes of one-time backup codes (shown once).
  ADD COLUMN IF NOT EXISTS twofa_backup_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- When 2FA was last enabled (for display only).
  ADD COLUMN IF NOT EXISTS twofa_enabled_at TIMESTAMPTZ;

-- Track "on lunch since" so the availability card can show a live timer.
-- (on_lunch boolean already exists from migration 034.)
ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS lunch_started_at TIMESTAMPTZ;

-- Short-lived login challenges. A row is created after the password step when
-- 2FA is required, and consumed when the employee enters the code. TTL-cleaned
-- by the retention cron; also self-expires via expires_at checks in code.
CREATE TABLE IF NOT EXISTS twofa_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  -- 'totp' | 'telegram' — how this challenge is verified.
  method TEXT NOT NULL,
  -- bcrypt hash of the delivered code (telegram only; NULL for totp which is
  -- verified against the stored secret directly).
  code_hash TEXT,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_twofa_challenges_manager
  ON twofa_challenges (manager_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_twofa_challenges_expires
  ON twofa_challenges (expires_at);
