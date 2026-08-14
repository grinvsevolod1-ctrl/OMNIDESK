-- 133: журнал входов сотрудника + мониторинг крон-джобов.
--
-- 1) Индекс под вкладку «Сессии» в настройках менеджера/куратора: выборка
--    «мои последние входы» из audit_log (action = 'auth.login', actor_id = я).
--    Частичный индекс — журнал растёт всеми действиями, а вкладке нужны
--    только login-события конкретного сотрудника.
CREATE INDEX IF NOT EXISTS idx_audit_log_logins_by_actor
  ON audit_log (actor_id, created_at DESC)
  WHERE action = 'auth.login';

-- 2) Учёт запусков крон-джобов. История lead_attachments показала, что джоб
--    может месяцами молча падать: единственным следом были строки в логах
--    PM2. Теперь каждый cron-роут фиксирует запуск здесь (fire-and-forget,
--    сбой записи не ломает сам джоб), а карточка «Здоровье системы» в
--    настройках админа подсвечивает джобы, которые давно не отрабатывали
--    успешно или стабильно падают.
CREATE TABLE IF NOT EXISTS cron_runs (
  id          bigserial PRIMARY KEY,
  job         text        NOT NULL,             -- 'followup', 'sync-ads', ...
  started_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,                          -- NULL = запись о старте потерялась
  ok          boolean     NOT NULL,
  -- Краткое сообщение об ошибке (до 500 символов, без стеков и секретов).
  error       text
);

-- Основной запрос мониторинга: «последние запуски каждого джоба».
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started
  ON cron_runs (job, started_at DESC);

-- Ретеншен-чистке (retention cron) нужен диапазон по времени.
CREATE INDEX IF NOT EXISTS idx_cron_runs_started
  ON cron_runs (started_at);
