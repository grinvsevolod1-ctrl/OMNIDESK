-- ПРИМЕЧАНИЕ: ранее этот файл назывался 045_finance_vault.sql и делил номер
-- 045 с 045_ads_integration.sql. Перенумерован в 052, чтобы номера были
-- уникальны. На БД, где старый файл уже применён, миграция применится повторно,
-- но это безопасно — все операции идемпотентны (IF NOT EXISTS).
--
-- Учёт → Хранилище: единое защищённое хранилище всех данных проекта.
--
-- Модель:
--   Ресурс (site.com)
--     └── Запись хранилища (категория: учётная запись / сервер / аккаунт /
--         соцсеть / счёт / почта / домен / API-ключ / БД / другое)
--           ├── login            (открытый: логин / e-mail / ник / номер)
--           ├── secret_enc       (ЗАШИФРОВАН: пароль / токен / ключ)
--           ├── url              (открытый: ссылка / хост)
--           ├── extra_enc        (ЗАШИФРОВАН JSON: произвольные доп. поля
--           │                     [{label, value, secret}] — IP, порт, PIN,
--           │                     seed-фразы, номера карт и т.д.)
--           ├── tags[]           (метки для фильтра)
--           └── favorite         (закреплённые вверху)
--
-- Секреты шифруются AES-256-GCM (lib/crypto.ts, ключ ENCRYPTION_KEY) — в БД
-- лежит только шифртекст. Всё admin-only (/admin/finance закрыт requireAdmin()).

CREATE TABLE IF NOT EXISTS finance_vault_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES finance_resources(id) ON DELETE CASCADE,
  -- 'credential' | 'server' | 'account' | 'social' | 'payment' |
  -- 'email' | 'domain' | 'api_key' | 'database' | 'other'
  category    text NOT NULL DEFAULT 'credential',
  title       text NOT NULL,
  -- Открытая часть: логин / e-mail / ник / номер счёта.
  login       text NOT NULL DEFAULT '',
  -- Зашифрованный основной секрет (пароль/токен). NULL, если секрета нет.
  secret_enc  text,
  -- Открытая ссылка / хост / адрес панели.
  url         text NOT NULL DEFAULT '',
  -- Зашифрованный JSON произвольных доп. полей. NULL, если полей нет.
  extra_enc   text,
  note        text NOT NULL DEFAULT '',
  tags        text[] NOT NULL DEFAULT '{}',
  favorite    boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finance_vault_items_resource_idx
  ON finance_vault_items (resource_id, favorite DESC, sort_order, created_at);

CREATE INDEX IF NOT EXISTS finance_vault_items_category_idx
  ON finance_vault_items (resource_id, category);
