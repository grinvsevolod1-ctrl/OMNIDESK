-- 175 — Исходящий контур: очередь лидов + тред первого касания.
--
-- Лиды прилетают из Telegram-бота-приёмника (владелец пересылает боту сообщения
-- из сторонней группы; вебхук app/api/outreach/bot парсит контакт и кладёт лид).
-- Менеджер во вкладке «Исходящие» видит назначенные ему лиды, пишет первым с
-- прогретого аккаунта и ведёт переписку.
--
-- Переписка НЕ смешивается с seller-инбоксом: тред читается живьём через
-- worker/src/personal.ts, а здесь фиксируются бизнес-факты и снимок сообщений
-- (outreach_messages) для истории/аналитики.

CREATE TABLE IF NOT EXISTS outreach_leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source              text NOT NULL DEFAULT 'telegram_bot',

  -- Контакт лида.
  tg_user_id          text,
  username            text,
  phone               text,
  display_name        text,

  -- Пересланное содержимое + контекст.
  raw_text            text,
  forwarded_from      text,

  status              text NOT NULL DEFAULT 'pending',
  assigned_manager_id uuid REFERENCES managers(id) ON DELETE SET NULL,
  account_id          uuid REFERENCES outreach_accounts(id) ON DELETE SET NULL,

  contacted_at        timestamptz,
  replied_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outreach_leads_status_check CHECK (
    status IN ('pending', 'assigned', 'contacted', 'replied', 'won', 'lost')
  )
);

-- Дедуп по tg_user_id (частичный — NULL допускаем: лид может прийти без id).
CREATE UNIQUE INDEX IF NOT EXISTS outreach_leads_tg_user_uniq
  ON outreach_leads (tg_user_id)
  WHERE tg_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outreach_leads_manager_idx
  ON outreach_leads (assigned_manager_id, status, created_at DESC);

-- Снимок сообщений треда первого касания (исходящие менеджера + ответы лида).
-- Отдельно от общего messages, чтобы ядро seller-инбокса не затрагивалось.
CREATE TABLE IF NOT EXISTS outreach_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           uuid NOT NULL REFERENCES outreach_leads(id) ON DELETE CASCADE,
  account_id        uuid REFERENCES outreach_accounts(id) ON DELETE SET NULL,
  direction         text NOT NULL,
  body              text NOT NULL DEFAULT '',
  provider_msg_id   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_messages_direction_check CHECK (
    direction IN ('out', 'in')
  )
);

CREATE INDEX IF NOT EXISTS outreach_messages_lead_idx
  ON outreach_messages (lead_id, created_at);
