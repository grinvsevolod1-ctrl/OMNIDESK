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

-- Added NOT VALID on purpose: this is a point-in-time snapshot of the allowed
-- channel types. A later migration (039) widens the set to include 'vk'. If the
-- migration tracker ever REPLAYS history against a database that is already at
-- HEAD (e.g. earlier migrations were applied by hand and schema_migrations was
-- empty), a plain ADD CONSTRAINT here would scan existing rows and fail on the
-- 'vk' channels that 039 legitimately introduced. NOT VALID adds the constraint
-- without validating pre-existing rows; it is still enforced for every new/
-- updated row, and 039 re-creates it validated with the full, correct set.
ALTER TABLE channels
  ADD CONSTRAINT channels_type_check
  CHECK (type IN ('telegram', 'whatsapp', 'livechat', 'max')) NOT VALID;
