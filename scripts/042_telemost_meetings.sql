-- Yandex Telemost video meetings.
--
-- The app-level OAuth token + defaults live in the existing key/value
-- `app_settings` store under key `telemost` (managed by the admin), so no
-- table is needed for configuration.
--
-- This table records every meeting a manager creates, for the manager's
-- "Видеовстречи" tab (history) and light auditing. A meeting may be tied to a
-- conversation (created from the inbox) or standalone (created from the tab).

CREATE TABLE IF NOT EXISTS telemost_meetings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id       uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  -- Nullable: standalone meetings created from the Видеовстречи tab have no
  -- conversation. ON DELETE SET NULL so meeting history survives a conversation
  -- being cleared.
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  -- Provider conference id (may be empty if the API omitted it).
  conference_id    text NOT NULL DEFAULT '',
  join_url         text NOT NULL,
  -- Whether the join link was delivered to a client through a channel.
  delivered        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telemost_meetings_manager_idx
  ON telemost_meetings (manager_id, created_at DESC);
