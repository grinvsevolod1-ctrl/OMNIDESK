-- 167 — Обращения в поддержку (проблемы и предложения по улучшению).
-- Любой авторизованный сотрудник (менеджер/куратор/руководитель/байер/админ)
-- может открыть тикет из шапки: описание + вложения (скриншоты/видео).
-- Тикет сохраняется здесь для истории И уходит в Telegram-бота владельцу
-- (тот же бот деплой-уведомлений: TELEGRAM_ALERT_BOT_TOKEN/CHAT_ID).
-- Вложения в БД не храним — они форвардятся в Telegram; тут только счётчик и
-- краткие метаданные (имя/размер/тип) на случай разбора постфактум.

CREATE TABLE IF NOT EXISTS support_tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 'problem' — ошибка/проблема в работе; 'suggestion' — предложение по улучшению.
  kind          text NOT NULL CHECK (kind IN ('problem', 'suggestion')),
  -- Автор на момент обращения (денормализация: кто пожаловался остаётся в истории,
  -- даже если сотрудника потом удалят). author_sub — id из сессии (sub).
  author_sub    text NOT NULL,
  author_name   text NOT NULL,
  author_email  text NOT NULL,
  author_role   text NOT NULL,
  description   text NOT NULL,
  attachments   jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Итог доставки в Telegram: 'sent' | 'partial' | 'failed' | 'not_configured'.
  delivery      text NOT NULL DEFAULT 'not_configured'
);

CREATE INDEX IF NOT EXISTS support_tickets_created_idx
  ON support_tickets (created_at DESC);

CREATE INDEX IF NOT EXISTS support_tickets_author_idx
  ON support_tickets (author_sub);
