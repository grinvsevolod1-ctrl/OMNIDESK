-- 140_lead_status_no_contact.sql
--
-- New curator lead status: "Не связался" (no_contact) — the curator has not
-- managed to reach the lead yet. Regular (non-final) status: the daily
-- confirmation gate still applies.

ALTER TABLE lead_cards DROP CONSTRAINT IF EXISTS lead_cards_status_check;
ALTER TABLE lead_cards
  ADD CONSTRAINT lead_cards_status_check
  CHECK (
    status IS NULL OR status IN (
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
