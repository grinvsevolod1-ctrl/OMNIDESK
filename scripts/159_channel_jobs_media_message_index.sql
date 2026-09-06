-- 159_channel_jobs_media_message_index.sql
-- Индекс под ленивое восстановление исходящих медиа из payload'ов джобов
-- (restoreMediaFromJobPayload в lib/data/media-archive.ts, зовётся из
-- /api/media/{id} для исходящих сообщений без media_blob_id).
--
-- Без него поиск джоба по payload->>'messageId' для send_file/send_voice —
-- seq scan по channel_jobs с детоастом каждого payload (а у голосовых и
-- файлов payload — весь файл в base64). Частичный индекс покрывает только
-- медиа-джобы, поэтому маленький; уникальный индекс миграции 126 покрывает
-- только send_message и здесь не помогает.
--
-- Safe to run multiple times.

CREATE INDEX IF NOT EXISTS idx_channel_jobs_media_message
  ON channel_jobs ((payload->>'messageId'))
  WHERE action IN ('send_file', 'send_voice');
