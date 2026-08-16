-- Omnidesk message media migration (run after 009_message_dedup.sql).
--
-- Adds OPTIONAL media descriptor columns to `messages` so the worker can record
-- that an incoming message carried media (a sticker, voice note, video note,
-- photo, audio, video or document) without storing the binary itself.
--
-- The actual bytes are NOT persisted. Instead `media_ref` keeps a small JSON
-- descriptor (provider peer + message id for Telegram, or a serialized message
-- envelope for WhatsApp) that lets the worker re-download the file on demand and
-- stream it to the panel via GET /api/media/{id}.
--
-- All columns are nullable, so existing text-only inserts keep working
-- unchanged. Safe to run multiple times.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_type text,
  ADD COLUMN IF NOT EXISTS media_mime text,
  ADD COLUMN IF NOT EXISTS media_name text,
  ADD COLUMN IF NOT EXISTS media_ref  jsonb;

-- Optional sanity constraint on the recognised media kinds. Kept permissive
-- (NULL allowed) so non-media rows are unaffected.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_messages_media_type'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT chk_messages_media_type
      CHECK (
        media_type IS NULL OR media_type IN (
          'image', 'video', 'video_note', 'audio', 'voice', 'sticker', 'document'
        )
      );
  END IF;
END $$;
