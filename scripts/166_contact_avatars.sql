-- 166_contact_avatars.sql
-- Кэш аватарок контактов (фото профиля) для инбокса.
--
-- Зачем таблица, а не запрос к воркеру на каждую плитку: резолв контакта в
-- entity + downloadProfilePhoto в Telegram МЕДЛЕННЫЙ и лимитируется (FLOOD_WAIT),
-- а список диалогов виртуализирован — при каждом скролле монтируются десятки
-- аватарок. Поэтому байты фото кладём один раз в media_blobs, а тут храним
-- маппинг (канал + хэндл контакта) → блоб, с отметкой времени для протухания и
-- флагом has_photo (у контакта может НЕ быть аватарки — кэшируем и это, чтобы
-- не долбить воркер впустую).
--
-- Идемпотентно: CREATE TABLE IF NOT EXISTS + guарды на индексы.

CREATE TABLE IF NOT EXISTS contact_avatars (
  channel_id     uuid        NOT NULL,
  contact_handle text        NOT NULL,
  -- media_blob_id NULL при has_photo=false («аватарки нет» — валидный кэш).
  media_blob_id  uuid        REFERENCES media_blobs(id) ON DELETE SET NULL,
  has_photo      boolean     NOT NULL DEFAULT false,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, contact_handle)
);

-- Протухание кэша чистится по fetched_at (см. lib/data/contact-avatars.ts).
CREATE INDEX IF NOT EXISTS contact_avatars_fetched_at_idx
  ON contact_avatars (fetched_at);
