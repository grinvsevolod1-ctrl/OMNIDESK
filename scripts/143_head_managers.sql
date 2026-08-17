-- 143_head_managers.sql
--
-- Руководитель (role = 'head', миграция 141) теперь может вести не только
-- кураторов, но и менеджеров продаж. Кураторская привязка живёт в
-- head_curators (141); менеджерская — здесь, отдельной таблицей head_managers.
-- Аддитивно: 141 не трогаем, чтобы уже существующие группы кураторов
-- остались как есть.
--
-- Как и куратор, менеджер принадлежит максимум одному руководителю
-- (UNIQUE на manager_id) — правило «руководитель видит только своих» остаётся
-- однозначным. Руководитель может одновременно вести и кураторов, и менеджеров.

CREATE TABLE IF NOT EXISTS head_managers (
  head_id    UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  manager_id UUID NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (head_id, manager_id),
  CONSTRAINT head_managers_manager_unique UNIQUE (manager_id)
);

CREATE INDEX IF NOT EXISTS idx_head_managers_head ON head_managers (head_id);
