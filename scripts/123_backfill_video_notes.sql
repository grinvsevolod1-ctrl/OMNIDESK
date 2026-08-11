-- 123: Бэкфилл «кружков» Telegram, исторически распознанных как аудио.
--
-- До исправления классификации (worker/src/telegram-media.ts) сообщения,
-- у которых Telegram-клиент ставил одновременно атрибуты round-video и audio,
-- попадали в БД как media_type = 'voice'/'audio', сохраняя при этом видео-MIME
-- (video/mp4 и т.п.). Из-за этого в Inbox они показывались как аудиоплеер
-- вместо круглого видеосообщения.
--
-- Ретипизируем такие строки в 'video_note' — рендер после этого показывает их
-- кружками. Условие по MIME 'video/%' гарантирует, что настоящие голосовые
-- (audio/ogg и т.д.) не будут затронуты.

UPDATE messages
   SET media_type = 'video_note'
 WHERE media_type IN ('voice', 'audio')
   AND media_mime LIKE 'video/%';
