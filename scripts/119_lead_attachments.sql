-- Вложения карточки лида: фото/видео от менеджера и куратора + телеграм-кружки.
--
-- Два источника содержимого:
--   * media_blob_id — файл, загруженный вручную (байты в media_blobs:
--     диск VPS через file_path или bytea, как у сообщений);
--   * message_id    — «кружок» (video_note) из реального диалога: вложение
--     ссылается на сообщение, байты стримятся тем же путём, что /api/media.
-- Хотя бы один источник обязателен.

CREATE TABLE IF NOT EXISTS lead_card_attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_card_id  UUID NOT NULL REFERENCES lead_cards (id) ON DELETE CASCADE,
  author_id     UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'video_note')),
  media_blob_id UUID REFERENCES media_blobs (id) ON DELETE CASCADE,
  message_id    UUID REFERENCES messages (id) ON DELETE CASCADE,
  file_name     TEXT,
  mime          TEXT,
  byte_size     BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (media_blob_id IS NOT NULL OR message_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_lead_card_attachments_card
  ON lead_card_attachments (lead_card_id, created_at DESC);

-- Один и тот же кружок нельзя прикрепить к карточке дважды.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_card_attachments_msg
  ON lead_card_attachments (lead_card_id, message_id)
  WHERE message_id IS NOT NULL;
