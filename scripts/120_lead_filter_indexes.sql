-- 120: составные индексы под фильтры лидов по периодам.
--
-- «Мои лиды» менеджера фильтруют по manager_id + created_at (пресеты
-- сегодня/7д/30д/день/период), «Все лиды» админа и панель куратора — по
-- transferred_at. Существующие одиночные индексы (manager_id, curator_id)
-- заставляли Postgres дочитывать и сортировать все строки менеджера/куратора.
-- Составные индексы отдают уже отсортированный диапазон.

-- Мои лиды: WHERE manager_id = $1 AND created_at >= ... ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_lead_cards_manager_created
  ON lead_cards (manager_id, created_at DESC);

-- Панель куратора: WHERE curator_id = $1 AND transferred_at IS NOT NULL
-- ORDER BY transferred_at DESC (частичный — черновики без передачи не индексируем)
CREATE INDEX IF NOT EXISTS idx_lead_cards_curator_transferred
  ON lead_cards (curator_id, transferred_at DESC)
  WHERE transferred_at IS NOT NULL;

-- Все лиды админа: фильтры по дате передачи без привязки к куратору
CREATE INDEX IF NOT EXISTS idx_lead_cards_transferred
  ON lead_cards (transferred_at DESC)
  WHERE transferred_at IS NOT NULL;

-- История статусов в карточке читается свежие-сверху
CREATE INDEX IF NOT EXISTS idx_lead_status_history_card_created
  ON lead_status_history (lead_card_id, created_at DESC);
