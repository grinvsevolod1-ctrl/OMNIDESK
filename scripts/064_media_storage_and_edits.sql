-- Durable media storage + message edit history (run after 063).
--
-- Two long-standing gaps this migration closes so NOTHING a contact sends is
-- ever lost, even if they later edit or delete it on their side:
--
--   1) Media bytes were never stored — the worker only kept a descriptor and
--      RE-DOWNLOADED the file from the provider on demand. The moment a contact
--      deleted a message, its photo/video/voice was gone forever. We now persist
--      the raw bytes in Postgres (bytea) at ingest time.
--
--   2) Edits were not tracked at all. We now keep a full, append-only history of
--      every prior version of a message (text + media snapshot), so the panel
--      can show "изменено" with the complete before/after trail.
--
-- All columns/tables are additive and nullable, so existing text-only inserts
-- keep working unchanged. Safe to run multiple times.

-- 1) Content-addressed-ish blob store. One row per stored binary. Referenced by
-- both live messages (messages.media_blob_id) and historical edit versions
-- (message_edits.media_blob_id). Bytes live in Postgres so they survive a
-- contact deleting/editing the original on their side.
CREATE TABLE IF NOT EXISTS media_blobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bytes       bytea NOT NULL,
  mime        text,
  name        text,
  byte_size   integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 2) Point a message at its stored bytes (nullable: legacy rows + text-only
-- messages have none, and the media route falls back to a live re-download).
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_blob_id uuid REFERENCES media_blobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS edited_at     timestamptz,
  ADD COLUMN IF NOT EXISTS edit_count    integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_media_blob ON messages(media_blob_id)
  WHERE media_blob_id IS NOT NULL;

-- 3) Append-only edit history. Each row is one PRIOR version of a message,
-- captured the instant before a newer version overwrote it. version 1 is the
-- earliest content we ever saw; higher numbers are later edits. The current
-- live text always lives on the messages row itself.
CREATE TABLE IF NOT EXISTS message_edits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  body          text NOT NULL DEFAULT '',
  media_type    text,
  media_mime    text,
  media_name    text,
  media_blob_id uuid REFERENCES media_blobs(id) ON DELETE SET NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_edits_message
  ON message_edits(message_id, version);

-- One version number per message.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_message_edits_version'
  ) THEN
    ALTER TABLE message_edits
      ADD CONSTRAINT uq_message_edits_version UNIQUE (message_id, version);
  END IF;
END $$;
