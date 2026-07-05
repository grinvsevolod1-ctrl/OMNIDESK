-- Off-hours messenger fallback for the website live chat.
--
-- When the live chat is outside working hours (08:00–17:00 Europe/Moscow) the
-- widget stops accepting messages and instead offers the visitor a set of
-- messenger links configured here by an admin. Telegram links and WhatsApp
-- phone numbers are handed out to visitors in round-robin order.

-- Single-row key/value store for global app settings (JSONB payloads).
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Atomic round-robin counters (one row per pool, e.g. 'telegram', 'whatsapp').
-- Incremented server-side so each visitor gets the next link in order.
CREATE TABLE IF NOT EXISTS offhours_counters (
  name text PRIMARY KEY,
  n    bigint NOT NULL DEFAULT 0
);

-- Seed the messenger config row so reads always have a stable shape.
INSERT INTO app_settings (key, value)
VALUES (
  'offhours_messengers',
  '{"telegramLinks": [], "whatsappPhones": []}'::jsonb
)
ON CONFLICT (key) DO NOTHING;
