-- 164: livechat-каналы должны переживать удаление владельца (manager_id = NULL).
--
-- Баг. `deleteManager` (lib/data/managers.ts) СОЗНАТЕЛЬНО оставляет livechat-
-- каналы живыми при удалении менеджера: воркер-каналы (telegram/whatsapp/vk/max)
-- удаляются явно, а livechat — это «standalone resource», который должен
-- сохраниться и просто показывать «нет свободных агентов», пока не назначат
-- нового. Механика держится на FK channels.manager_id → managers.id
-- ON DELETE SET NULL (со времён миграции 008): при удалении менеджера его id в
-- livechat-канале обнуляется, а из пула round-robin он вычищается отдельным
-- UPDATE.
--
-- Миграция 135 (личные Telegram-аккаунты) переписала CHECK так:
--     type = 'telegram_personal' OR manager_id IS NOT NULL
-- и НЕ учла livechat. В результате ON DELETE SET NULL на livechat-канале стал
-- нарушать этот CHECK, и УДАЛЕНИЕ ЛЮБОГО менеджера, владеющего хотя бы одним
-- livechat-каналом, падало с ошибкой channels_manager_required_check.
--
-- Фикс. Разрешаем NULL manager_id и для livechat — ровно то поведение, которое
-- `deleteManager` документирует и на которое рассчитывает. Для остальных
-- «привязанных к воркеру» типов (telegram, whatsapp, vk, max) manager_id
-- остаётся обязательным, как и задумано в 135.

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_manager_required_check;
ALTER TABLE channels
  ADD CONSTRAINT channels_manager_required_check
  CHECK (type IN ('telegram_personal', 'livechat') OR manager_id IS NOT NULL);
