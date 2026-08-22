-- 144_lead_status_new.sql
--
-- Новый кураторский статус «NEW»: лид, только что переданный менеджером,
-- по умолчанию получает status = 'new'. Вручную поставить его нельзя
-- (не показывается в списках выбора — enforced в приложении). Ежедневный
-- гейт для NEW действует как для «без статуса»: куратор обязан подтвердить
-- реальный статус с комментарием.

ALTER TABLE lead_cards DROP CONSTRAINT IF EXISTS lead_cards_status_check;
ALTER TABLE lead_cards
  ADD CONSTRAINT lead_cards_status_check
  CHECK (
    status IS NULL OR status IN (
      'new',
      'awaiting_exit',
      'training',
      'working',
      'temporarily_off',
      'refused',
      'ignore',
      'left',
      'no_contact'
    )
  );

ALTER TABLE lead_cards DROP CONSTRAINT IF EXISTS lead_cards_previous_status_check;
ALTER TABLE lead_cards
  ADD CONSTRAINT lead_cards_previous_status_check
  CHECK (
    previous_status IS NULL OR previous_status IN (
      'new',
      'awaiting_exit',
      'training',
      'working',
      'temporarily_off',
      'refused',
      'ignore',
      'left',
      'no_contact'
    )
  );

-- Backfill: активные переданные лиды без статуса — это и есть «только что
-- зашедшие» — получают NEW. Архив и корзину не трогаем.
UPDATE lead_cards
   SET status = 'new', updated_at = now()
 WHERE status IS NULL
   AND curator_id IS NOT NULL
   AND transferred_at IS NOT NULL
   AND archived_at IS NULL
   AND deleted_at IS NULL;
