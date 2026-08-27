-- 147: ИИ-автопилот god-мессенджера («ИИ в чатах», /wijegniwjgwjog/messages).
--
-- Владелец из мессенджера включает ИИ, который САМ создаёт новые входящие
-- диалоги «от имени клиентов» в выбранных каналах в ХАОТИЧНОЕ время внутри
-- рабочего окна (МСК) и ВЕДЁТ их — отвечает менеджеру как живой клиент, пока
-- диалог естественно не завершится.
--
-- ИЗОЛЯЦИЯ (AGENTS.md §4): таблицы godовые, actions работают под
-- assertConsoleOrMessenger и НЕ пишут в admin-видимый журнал аудита; обычная
-- админка / Admin AI о них не знают. Диалоги, созданные автопилотом, —
-- ОБЫЧНЫЕ реальные диалоги (никакой фильтрации по is_simulated: изоляция про
-- невидимость интерфейса, а не про резку данных).
--
-- Это НЕ воскрешение удалённого lib/client-sim/* (миграция 090): отдельная,
-- godовая подсистема под собственным неймспейсом god_ai_*.

-- Единственная строка конфигурации автопилота (id всегда = 1).
CREATE TABLE IF NOT EXISTS god_ai_config (
  id             SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled        BOOLEAN NOT NULL DEFAULT false,
  -- Тематика: владелец пишет максимально подробно, ИИ строго следует ей.
  topic          TEXT NOT NULL DEFAULT '',
  -- Каналы, в которых создавать диалоги (массив id каналов).
  channel_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Рабочее окно в минутах от полуночи МСК (600 = 10:00, 1320 = 22:00).
  work_start_min INTEGER NOT NULL DEFAULT 600,
  work_end_min   INTEGER NOT NULL DEFAULT 1320,
  -- Сколько новых диалогов создавать за день (в среднем).
  daily_target   INTEGER NOT NULL DEFAULT 5,
  -- Максимум клиентских реплик в одном диалоге до естественного завершения.
  max_turns      INTEGER NOT NULL DEFAULT 8,
  -- Продолжать ли отвечать менеджеру как клиент (ведение диалога).
  reply_enabled  BOOLEAN NOT NULL DEFAULT true,
  -- Переопределение модели AI Gateway (иначе — дефолт мозга).
  model          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO god_ai_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Диалоги под управлением автопилота: персона «клиента» + счётчик реплик.
-- persona хранит жанр/манеру/цель — за счёт этого каждый диалог отличается
-- по тексту и жанру, хотя тематика одна.
CREATE TABLE IF NOT EXISTS god_ai_threads (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  persona         JSONB NOT NULL,
  active          BOOLEAN NOT NULL DEFAULT true,
  turns           INTEGER NOT NULL DEFAULT 0,
  max_turns       INTEGER NOT NULL DEFAULT 8,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_god_ai_threads_active
  ON god_ai_threads (active) WHERE active;

-- Хаотичное расписание создания новых диалогов: на каждый рабочий день
-- планировщик раскидывает daily_target слотов на случайные моменты внутри
-- рабочего окна. Крон создаёт диалог, когда слот «доспел» (fire_at <= now).
CREATE TABLE IF NOT EXISTS god_ai_slots (
  id              UUID PRIMARY KEY,
  fire_at         TIMESTAMPTZ NOT NULL,
  done            BOOLEAN NOT NULL DEFAULT false,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Быстрый поиск «доспевших» невыполненных слотов.
CREATE INDEX IF NOT EXISTS idx_god_ai_slots_due
  ON god_ai_slots (fire_at) WHERE NOT done;
