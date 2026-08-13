-- Отдельное поле Telegram ID у карточки лида.
--
-- Раньше при отсутствии номера телефона в поле phone автоматически попадал
-- числовой Telegram ID контакта (contactHandle) — телефон и ID смешивались.
-- Теперь ID живёт в своей колонке, а телефон остаётся телефоном.

ALTER TABLE lead_cards
  ADD COLUMN IF NOT EXISTS telegram_id TEXT NOT NULL DEFAULT '';

-- Разовая чистка исторических данных: если в телефоне лежит «голый» числовой
-- Telegram ID (7+ цифр без «+» — телефоны менеджеры вводят с плюсом или
-- форматированием), переносим его в telegram_id и очищаем телефон.
UPDATE lead_cards
   SET telegram_id = phone,
       phone = ''
 WHERE telegram_id = ''
   AND phone ~ '^[0-9]{7,}$'
   AND phone !~ '^[78][0-9]{10}$';
