-- Учёт: доходы/расходы по ресурсам.
--
-- Трёхуровневая модель, как описал заказчик:
--   Ресурс (site.com)
--     └── Раздел / вкладка (Материалы, Реклама, Хостинг…)
--           └── Запись (строка учёта: доход или расход)
--                 └── Чек-лист подзадач ("пункты выполненных задач")
--
-- Всё admin-only: страница /admin/finance закрыта requireAdmin(). Отдельной
-- привязки к менеджеру нет — это внутренний учёт администратора.

-- 1) Ресурсы верхнего уровня (например, site.com).
CREATE TABLE IF NOT EXISTS finance_resources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Валюта отображения сумм внутри ресурса. По умолчанию USDT, можно сменить
  -- на RUB прямо во вкладке. Проверка на уровне приложения.
  currency    text NOT NULL DEFAULT 'USDT',
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 2) Разделы (вкладки) внутри ресурса.
CREATE TABLE IF NOT EXISTS finance_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES finance_resources(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_sections_resource_idx
  ON finance_sections (resource_id, sort_order, created_at);

-- 3) Записи учёта внутри раздела.
--    resource_id дублируется намеренно (денормализация) — чтобы агрегаты по
--    ресурсу считались без джойна через разделы и переживали перенос записи.
CREATE TABLE IF NOT EXISTS finance_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  uuid NOT NULL REFERENCES finance_sections(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES finance_resources(id) ON DELETE CASCADE,
  title       text NOT NULL,
  -- 'income' | 'expense'
  type        text NOT NULL DEFAULT 'expense',
  -- Сумма в валюте ресурса. Всегда неотрицательная; знак задаёт type.
  amount      numeric(14, 2) NOT NULL DEFAULT 0,
  -- 'planned' | 'in_progress' | 'done' | 'cancelled'
  status      text NOT NULL DEFAULT 'planned',
  -- Свободный текст: ответы, комментарии, детали.
  notes       text NOT NULL DEFAULT '',
  entry_date  date NOT NULL DEFAULT CURRENT_DATE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_entries_section_idx
  ON finance_entries (section_id, entry_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS finance_entries_resource_idx
  ON finance_entries (resource_id, entry_date DESC);

-- 4) Пункты чек-листа для записи ("выполненные задачи").
CREATE TABLE IF NOT EXISTS finance_entry_tasks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id   uuid NOT NULL REFERENCES finance_entries(id) ON DELETE CASCADE,
  label      text NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_entry_tasks_entry_idx
  ON finance_entry_tasks (entry_id, sort_order, created_at);
