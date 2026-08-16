-- Live-chat visitor metadata
--
-- Adds a privacy-scoped JSONB blob to conversations so a manager can see basic
-- context about a website visitor (IP, browser/OS, page, locale, first/last
-- seen). This is additive only — no existing routes, triggers or behaviour
-- change, and the column defaults to an empty object for all existing rows.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb;
