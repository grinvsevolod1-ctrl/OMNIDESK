-- 036_lead_conversion_webhook.sql
-- Conversion confirmation webhook support.
--
-- When a manager (or autopilot) sends the FIRST outbound message to a visitor,
-- we notify an external system that the lead has converted, passing along the
-- order code (e.g. "A7K4M2") that the client included in their first message.
--
--   * lead_code          — the order code parsed from the client's inbound
--                          message(s). Cached here so we don't re-parse and so
--                          it can be inspected/edited later.
--   * conversion_sent_at — set the moment we successfully claim the conversion
--                          for delivery. Doubles as an idempotency guard so the
--                          webhook fires exactly once per conversation, even
--                          under concurrent sends. Reset to NULL on delivery
--                          failure so the next outbound message retries.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS lead_code TEXT;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS conversion_sent_at TIMESTAMPTZ;
