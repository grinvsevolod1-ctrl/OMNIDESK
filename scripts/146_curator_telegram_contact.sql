-- 146: Telegram-контакт куратора для кандидатов.
-- Куратор сам указывает и обновляет свой актуальный Telegram в настройках
-- («Мои ГЕО»). Менеджер видит контакт при передаче лида и отправляет его
-- кандидату — кандидат пишет куратору сам. Хранится в каноническом виде
-- «@username» (нормализация из @username / t.me-ссылок — lib/telegram-contact.ts).
ALTER TABLE managers ADD COLUMN IF NOT EXISTS telegram_contact TEXT;
