-- OMNIDESK OS shell: dialog memory + scheduled commands.
--
-- console_sessions  — one row per admin identity: the running dialog history
--                     of the OS shell, so a reload / new browser keeps context.
-- console_schedules — recurring commands ("каждый понедельник — отчёт по
--                     лидам"): the copilot creates them, a cron-like runner
--                     executes the prompt through the same assistant core.

CREATE TABLE IF NOT EXISTS console_sessions (
  -- Admin subject from the session JWT (env-based admin => TEXT, not FK).
  user_id    TEXT PRIMARY KEY,
  -- Trimmed AssistantTurn[] (role + content), newest last.
  turns      JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS console_schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  label       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  -- 'hourly' | 'daily' | 'weekly:<1-7>' (ISO weekday, 1 = Monday)
  schedule    TEXT NOT NULL,
  -- Minutes since midnight (server TZ) for daily/weekly runs.
  run_minute  INTEGER NOT NULL DEFAULT 540,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  -- Last execution's reply text (shown when the admin asks "что по отчётам").
  last_result TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_console_schedules_due
  ON console_schedules (next_run_at)
  WHERE enabled;
