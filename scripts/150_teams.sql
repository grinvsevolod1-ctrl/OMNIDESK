-- 150: Команды — единая орг-единица вместо head_curators / head_managers.
--
-- Руководитель (role = 'head') становится ВЛАДЕЛЬЦЕМ именованной команды.
-- Кураторы и менеджеры продаж входят в команду через managers.team_id
-- (≤ 1 команда на человека, как раньше был ≤ 1 руководитель). Лид,
-- переданный менеджером, направляется в КОМАНДУ (lead_cards.team_id) и
-- разбирается кураторами вручную (claim). Существующие группы руководителей
-- переносятся в команды без потери данных, затем join-таблицы удаляются —
-- остаётся один источник правды.
--
-- Форвард-онли, применяется деплоем ДО кода. Раннер оборачивает файл в
-- BEGIN/COMMIT сам — здесь своих транзакций нет.

CREATE TABLE IF NOT EXISTS teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  -- Владелец-руководитель; NULL = команда без руководителя (ведёт админ).
  head_id    UUID NULL REFERENCES managers(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Членство: у куратора/менеджера ≤ 1 команда.
ALTER TABLE managers
  ADD COLUMN IF NOT EXISTS team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL;

-- Команда-пул, в которую направлен лид (curator_id заполняется при claim).
ALTER TABLE lead_cards
  ADD COLUMN IF NOT EXISTS team_id UUID NULL REFERENCES teams(id) ON DELETE SET NULL;

-- Перенос существующих групп руководителей в команды (без потери данных).
-- Для каждого head — своя команда «Команда {имя}»; все его кураторы и
-- менеджеры получают team_id этой команды.
DO $migrate_heads$
DECLARE
  h   RECORD;
  tid UUID;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'head_curators'
  ) THEN
    FOR h IN SELECT id, name FROM managers WHERE role = 'head' LOOP
      INSERT INTO teams (name, head_id)
      VALUES ('Команда ' || COALESCE(NULLIF(trim(h.name), ''), 'без имени'), h.id)
      RETURNING id INTO tid;

      UPDATE managers
         SET team_id = tid
       WHERE id IN (SELECT curator_id FROM head_curators WHERE head_id = h.id)
          OR id IN (SELECT manager_id FROM head_managers WHERE head_id = h.id);
    END LOOP;
  END IF;
END
$migrate_heads$;

-- Бэкфилл лидов: закреплённые лиды привязываются к команде своего куратора,
-- чтобы аналитика по команде видела всю историю.
UPDATE lead_cards lc
   SET team_id = m.team_id
  FROM managers m
 WHERE lc.curator_id = m.id
   AND m.team_id IS NOT NULL
   AND lc.team_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_managers_team ON managers(team_id);
CREATE INDEX IF NOT EXISTS idx_teams_head ON teams(head_id);
CREATE INDEX IF NOT EXISTS idx_lead_cards_team ON lead_cards(team_id);
-- Быстрый пул: непринятые (curator_id IS NULL), не в архиве лиды команды.
CREATE INDEX IF NOT EXISTS idx_lead_cards_pool
  ON lead_cards(team_id)
  WHERE curator_id IS NULL AND archived_at IS NULL;

-- Единый источник правды — teams/managers.team_id. Join-таблицы больше не нужны.
DROP TABLE IF EXISTS head_curators;
DROP TABLE IF EXISTS head_managers;
