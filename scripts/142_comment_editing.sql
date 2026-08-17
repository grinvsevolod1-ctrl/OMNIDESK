-- 142_comment_editing.sql
--
-- Same-day comment editing with full revision history.
-- A comment can be edited only by its author and only on the Moscow calendar
-- day it was created (enforced in the app, like the daily status deadline).
-- Every edit stores the previous text in lead_card_comment_revisions, so the
-- old versions stay visible to everyone who can see the comment.

ALTER TABLE lead_card_comments
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS lead_card_comment_revisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id     UUID NOT NULL REFERENCES lead_card_comments (id) ON DELETE CASCADE,
  -- Text as it was BEFORE this edit.
  previous_body  TEXT NOT NULL,
  edited_by      UUID REFERENCES managers (id) ON DELETE SET NULL,
  -- Snapshot survives account deletion.
  edited_by_name TEXT,
  edited_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_card_comment_revisions_comment
  ON lead_card_comment_revisions (comment_id, edited_at DESC);
