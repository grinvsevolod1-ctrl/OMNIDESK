-- Human-readable visitor numbers for live-chat conversations.
--
-- Website visitors arrive anonymously ("Website visitor"), which makes several
-- concurrent threads on the same site indistinguishable in the inbox. We give
-- each NEW visitor a small per-channel ordinal (#1, #2, #3 …) so a manager can
-- refer to "посетитель #7" at a glance. The number is scoped PER CHANNEL, so two
-- different sites each start their own count at #1.
--
-- Numbers are assigned only to live-chat conversations (messenger contacts have
-- real names/usernames already). Existing rows stay NULL and the UI simply
-- omits the badge for them.
--
-- Safe to run multiple times.

-- Per-conversation ordinal, filled in at creation time (see
-- recordLivechatInbound). NULL for messenger threads and pre-existing rows.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS visitor_no integer;

-- Atomic per-channel counter. We bump and return next_no in a single upsert so
-- concurrent first-messages from different visitors can never collide on the
-- same number.
CREATE TABLE IF NOT EXISTS livechat_visitor_seq (
  channel_id uuid PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  next_no    integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill the counter for channels that already have numbered visitors, so a
-- re-run (or a deploy after some numbers were assigned) keeps counting upward
-- instead of restarting at 1.
INSERT INTO livechat_visitor_seq (channel_id, next_no)
SELECT channel_id, MAX(visitor_no)
  FROM conversations
 WHERE visitor_no IS NOT NULL
 GROUP BY channel_id
ON CONFLICT (channel_id)
DO UPDATE SET next_no = GREATEST(livechat_visitor_seq.next_no, EXCLUDED.next_no);
