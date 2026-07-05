-- Add VK (vk.com) communities as a new channel type.
--
-- VK communities integrate via the official Callback API: inbound events
-- (message_new) arrive over a per-channel webhook handled inside Next.js (no
-- worker session, like live-chat / MAX) and outbound is sent directly via
-- https://api.vk.com/method/messages.send.
--
-- On connect we validate the community access token (groups.getById), fetch the
-- Callback confirmation string (groups.getCallbackConfirmationCode), register a
-- callback server pointed at /api/vk/webhook/[channelId]
-- (groups.addCallbackServer) and switch on the message_new event
-- (groups.setCallbackSettings).
--
-- Stored in channels.config:
--   token            – community access token, ENCRYPTED (AES-256-GCM, lib/crypto)
--   webhookSecret    – random per-channel secret, ENCRYPTED; verified against the
--                      `secret` field VK sends with every callback request
--   confirmationCode – plaintext string echoed back on the Callback handshake
--   groupId          – plaintext numeric VK community id
--   serverId         – plaintext VK-assigned callback server id (for teardown)
--
-- Run on your VPS:  psql "$DATABASE_URL" -f scripts/039_vk_channel.sql

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;

ALTER TABLE channels
  ADD CONSTRAINT channels_type_check
  CHECK (type IN ('telegram', 'whatsapp', 'livechat', 'max', 'vk'));
