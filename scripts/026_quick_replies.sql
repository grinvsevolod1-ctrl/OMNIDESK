-- Quick replies (canned responses) authored by a manager for their own use.
--
-- Each manager builds a personal library of short reusable answers. In the
-- inbox composer these appear as one-tap chips above the message input, so a
-- manager can drop a prepared answer into the draft instantly. Scoped per
-- manager: a reply belongs to exactly one manager and is never shared.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS quick_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id  uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  -- Short label shown on the chip (e.g. "Приветствие"). Optional — falls back
  -- to a trimmed preview of the body in the UI when empty.
  title       text NOT NULL DEFAULT '',
  -- The actual message text inserted into the composer draft.
  body        text NOT NULL,
  -- Manual ordering controlled by the manager (lower = earlier).
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quick_replies_manager
  ON quick_replies(manager_id, sort_order, created_at);
