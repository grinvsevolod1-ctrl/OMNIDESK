-- 148: снос ИИ-автопилота god-мессенджера (введён миграцией 147).
--
-- Модуль удалён из кода целиком (lib/god-autopilot, крон /api/cron/god-ai,
-- server actions, UI-кнопка в мессенджере). Диалоги, которые автопилот успел
-- создать, — обычные диалоги в conversations/messages и остаются нетронутыми
-- (изоляция god-панели — про невидимость интерфейса, не про резку данных).
-- Сносим только служебные таблицы неймспейса god_ai_*.

DROP TABLE IF EXISTS god_ai_slots;
DROP TABLE IF EXISTS god_ai_threads;
DROP TABLE IF EXISTS god_ai_config;
