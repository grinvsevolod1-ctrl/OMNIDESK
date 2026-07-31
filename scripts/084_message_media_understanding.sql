-- 084_message_media_understanding.sql
-- Lets the AI manager actually UNDERSTAND images and audio a client sends,
-- instead of seeing only a bare "[Фото]" / "[Голосовое]" placeholder.
--
-- When the AI is about to reply and the thread contains a media message, the
-- brain analyzes it once (vision for images, speech-to-text for voice/audio)
-- and caches the short Russian result here. On later turns we reuse the cache
-- instead of paying for the model again — so understanding costs at most one
-- extra call per media message, ever.
--
-- Nullable + no default: existing rows and plain-text messages simply stay NULL,
-- so this is a zero-risk, idempotent add.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_understanding text;

-- Partial index over media messages still awaiting analysis, so the lazy
-- "needs understanding" lookup during reply generation stays cheap.
CREATE INDEX IF NOT EXISTS idx_messages_media_understanding_pending
  ON messages (id)
  WHERE media_type IS NOT NULL AND media_understanding IS NULL;
