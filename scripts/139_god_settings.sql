-- 139: настройки god-панели в БД (key-value).
--
-- Первый потребитель — ключ Get My TG (вкладка «API TG»). Раньше ключ жил
-- ТОЛЬКО в env `GMT_API_KEY` (fail-closed, как SECRET_PANEL_PASSWORD). По
-- решению владельца ключ теперь назначается прямо из god-панели и хранится
-- в БД (прецедент — api_key_plain god-сайтов, миграция 137). Env-переменная
-- остаётся fallback'ом для обратной совместимости: БД имеет приоритет.
--
-- Таблица godовая: никакие admin-видимые выборки её не читают, actions
-- работают только под requireGod и НЕ пишут в admin-видимый журнал аудита
-- (СВЯЩЕННЫЙ ИНВАРИАНТ, AGENTS.md §4).

CREATE TABLE IF NOT EXISTS god_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
