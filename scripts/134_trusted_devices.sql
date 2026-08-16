-- 134: доверенные устройства для 2FA + реестр известных устройств входа.
--
-- trusted_devices: «запомнить это устройство на 30 дней» после успешного
-- 2FA. В cookie уходит случайный токен, в БД хранится ТОЛЬКО его SHA-256
-- (кража дампа БД не даёт готовых пропусков). Привязка к session_version:
-- «разлогинить все устройства» и смена пароля мгновенно обесценивают все
-- выданные пропуски без отдельной чистки.
--
-- login_devices: пары (устройство, IP), с которых сотрудник уже входил.
-- Не секьюрити-барьер, а триггер уведомления: INSERT новой пары = вход с
-- нового устройства -> push «Это вы?» с кнопками подтверждения/разлогина.

CREATE TABLE IF NOT EXISTS trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  -- session_version на момент выдачи: расходится с текущим -> пропуск мёртв.
  session_version integer NOT NULL DEFAULT 0,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS trusted_devices_manager_idx
  ON trusted_devices (manager_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS login_devices (
  manager_id uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  -- Нормализованный отпечаток устройства (браузер+ОС, не сырой UA — он
  -- меняется с каждым минорным обновлением браузера) + IP.
  device_key text NOT NULL,
  ip text NOT NULL,
  user_agent text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manager_id, device_key, ip)
);
