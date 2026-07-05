-- Source groups: bundle the channels that belong to ONE website / source.
--
-- A "source" is typically a single site on which the live-chat widget is
-- installed, together with the Telegram and WhatsApp accounts that site routes
-- its visitors to. Grouping is a one-time setup and is used ONLY for the admin
-- overview report (how many people wrote, where, which messengers, per day) —
-- it does NOT affect the inbox or message routing in any way.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS source_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Link channels -> a group. A channel belongs to at most one group (UNIQUE),
-- mirroring the mental model "this TG/WA/site is part of one source".
CREATE TABLE IF NOT EXISTS source_group_channels (
  group_id    uuid NOT NULL REFERENCES source_groups(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_sgc_group ON source_group_channels(group_id);
