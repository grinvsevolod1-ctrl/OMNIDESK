-- Add the MAX messenger as a new channel type.
--
-- MAX (dev.max.ru) integrates via its official Bot API: inbound arrives over a
-- per-channel webhook handled inside Next.js (no worker session, like live-chat)
-- and outbound is sent directly via POST https://botapi.max.ru/messages.
--
-- Both the bot token (channels.config.token) and the webhook secret
-- (channels.config.webhookSecret) are stored ENCRYPTED with AES-256-GCM via
-- lib/crypto. The secret is verified against the X-Max-Bot-Api-Secret header on
-- every webhook request.
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/032_max_channel.sql

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;

ALTER TABLE channels
  ADD CONSTRAINT channels_type_check
  CHECK (type IN ('telegram', 'whatsapp', 'livechat', 'max'));
