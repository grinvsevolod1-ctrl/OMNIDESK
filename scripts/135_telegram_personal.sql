-- 135: Личные Telegram-аккаунты god-панели (тип канала telegram_personal).
--
-- Максимально отдельная структура: переписка НЕ хранится в БД (читается
-- живьём из Telegram через worker), поэтому никаких таблиц под сообщения.
-- Единственное, что нужно схеме:
--
--   1. Разрешить type = 'telegram_personal' в CHECK-констрейнте channels.
--      Все существующие запросы панели фильтруют type = 'telegram' (или
--      перечисляют типы явно), поэтому личные аккаунты автоматически
--      НЕВИДИМЫ для админки, менеджеров, мозга продавца и Admin AI —
--      изоляция fail-closed без единого нового фильтра.
--
--   2. Ослабить NOT NULL на manager_id: личный аккаунт владельца не
--      принадлежит ни одному менеджеру. Целостность для обычных типов
--      сохраняет новый CHECK: у всех НЕ-personal каналов manager_id
--      обязателен, как и раньше.

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
ALTER TABLE channels
  ADD CONSTRAINT channels_type_check
  CHECK (type IN ('telegram', 'whatsapp', 'livechat', 'max', 'vk', 'telegram_personal'));

ALTER TABLE channels ALTER COLUMN manager_id DROP NOT NULL;

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_manager_required_check;
ALTER TABLE channels
  ADD CONSTRAINT channels_manager_required_check
  CHECK (type = 'telegram_personal' OR manager_id IS NOT NULL);
