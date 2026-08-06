-- 117: Lead lifecycle — archive for final statuses + SLA settings.
--
-- 1) lead_cards.archived_at: final leads (refused / left) leave the active
--    workspace. Archived leads are excluded from the daily status gate,
--    discipline metrics and curator load counts.
-- 2) lead_sla_settings: chat-configured singleton (like ai_followup_settings)
--    with archive/escalation thresholds — no hardcoded behaviour.

ALTER TABLE lead_cards
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_lead_cards_archived
  ON lead_cards (curator_id, archived_at)
  WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS lead_sla_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Auto-archive final leads (refused/left) this many days after the final
  -- status was confirmed. 0 disables auto-archive (manual only).
  archive_after_days integer NOT NULL DEFAULT 14
    CHECK (archive_after_days BETWEEN 0 AND 365),
  -- Escalate when a lead sits in «Игнор» this many consecutive days.
  -- 0 disables this escalation.
  ignore_alert_days integer NOT NULL DEFAULT 5
    CHECK (ignore_alert_days BETWEEN 0 AND 365),
  -- Escalate when a lead sits in «Ожидает выхода» this many consecutive days.
  -- 0 disables this escalation.
  awaiting_exit_alert_days integer NOT NULL DEFAULT 10
    CHECK (awaiting_exit_alert_days BETWEEN 0 AND 365),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO lead_sla_settings (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;
