-- Удаление фичи «Цели конверсии».
-- Весь код фичи (components/admin/goals-admin.tsx, components/analytics/analytics-parts.tsx,
-- app/actions/goals.ts, функции *ConversionGoal* в lib/data/analytics.ts) удалён
-- в рамках аудита кодовой базы — таблица больше нигде не читается и не пишется.
-- Клики по мессенджерам (messenger_clicks) не затрагиваются: аналитика кликов живёт отдельно.

DROP TABLE IF EXISTS conversion_goals;
