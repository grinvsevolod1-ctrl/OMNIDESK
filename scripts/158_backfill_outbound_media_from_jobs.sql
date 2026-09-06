-- 158_backfill_outbound_media_from_jobs.sql
-- Восстановление исходящих медиа, отправленных из панели ДО того, как байты
-- начали архивироваться в момент отправки.
--
-- Проблема: фото/файлы/голосовые, отправленные менеджером или куратором из
-- композера, записывались в messages без сохранённых байт (media_blob_id IS
-- NULL) и показывались только «живой» до-качкой из Telegram по
-- provider_message_id. В god-созданных (синтетических) диалогах воркер по
-- дизайну вообще не ходит в Telegram (settleSyntheticSend) — provider id не
-- записывается никогда, и такие вложения были невосстановимы «снаружи»:
-- в панели вечная плашка «Медиа недоступно» (410 от воркера).
--
-- Но сами байты у нас ЕСТЬ: джобы send_file / send_voice несут файл в payload
-- целиком (base64 в payload->>'file' / payload->>'audio') вместе с
-- payload->>'messageId', а завершённые джобы живут в channel_jobs 7 дней
-- (purgeFinishedChannelJobs). Эта миграция один раз проходит по всем исходящим
-- медиа-сообщениям без блоба, находит их джоб и переносит байты в media_blobs —
-- ровно так же, как это теперь делает storeMessageMediaBytes при отправке.
--
-- Идемпотентно: трогаем только строки с media_blob_id IS NULL; повторный запуск
-- ничего не дублирует. Байты кладём inline (bytea) — офлоад-свип миграции 107
-- сам переложит их на диск/S3. Битый base64 или пустой/слишком большой файл
-- (> 50 МБ, как MEDIA_MAX_STORE_BYTES) пропускаем, не роняя миграцию.
-- Вложения старше 7 дней, чей джоб уже вычищен, восстановить нечем — они
-- остаются в «Медиа недоступно» (для реальных диалогов ретрай в UI ещё
-- попробует до-качать их из Telegram по provider id).

DO $$
DECLARE
  r        RECORD;
  bin      bytea;
  blob_id  uuid;
  restored integer := 0;
  skipped  integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (m.id)
           m.id AS message_id,
           j.action,
           CASE WHEN j.action = 'send_file'
                THEN j.payload->>'file'
                ELSE j.payload->>'audio'
           END AS b64,
           COALESCE(
             m.media_mime,
             j.payload->>'mime',
             CASE WHEN j.action = 'send_voice' THEN 'audio/ogg' END
           ) AS mime,
           COALESCE(m.media_name, j.payload->>'name') AS name
      FROM messages m
      JOIN channel_jobs j
        ON j.payload->>'messageId' = m.id::text
       AND j.action IN ('send_file', 'send_voice')
     WHERE m.direction = 'out'
       AND m.media_type IS NOT NULL
       AND m.media_blob_id IS NULL
     ORDER BY m.id, j.created_at DESC
  LOOP
    IF r.b64 IS NULL OR r.b64 = '' THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    BEGIN
      bin := decode(r.b64, 'base64');
    EXCEPTION WHEN OTHERS THEN
      skipped := skipped + 1;
      CONTINUE;
    END;

    IF octet_length(bin) = 0 OR octet_length(bin) > 50 * 1024 * 1024 THEN
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO media_blobs (bytes, mime, name, byte_size)
    VALUES (bin, r.mime, r.name, octet_length(bin))
    RETURNING id INTO blob_id;

    UPDATE messages
       SET media_blob_id = blob_id
     WHERE id = r.message_id
       AND media_blob_id IS NULL;

    restored := restored + 1;
  END LOOP;

  RAISE NOTICE '158: restored % outbound media blob(s) from channel_jobs payloads, skipped %',
    restored, skipped;
END $$;
