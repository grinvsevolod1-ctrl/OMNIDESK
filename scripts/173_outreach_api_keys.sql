-- 173 — Исходящий контур: пул Telegram API-ключей (api_id/api_hash).
--
-- Анти-бан требует, чтобы боевые аккаунты не висели все на одной паре
-- api_id/api_hash: Telegram привязывает «приложение» к паре ключей, и десятки
-- аккаунтов с одного app_id — явный признак фермы. Поэтому у исходящего контура
-- свой ПУЛ ключей: каждый новый аккаунт вешается на наименее загруженный ключ
-- (см. lib/data/outreach-accounts.ts::pickApiKeyForNewAccount).
--
-- api_hash хранится ЗАШИФРОВАННЫМ (lib/crypto, AES-256-GCM) — как и все секреты
-- в проекте (сессии, токены, прокси). api_id не секрет (виден в каждом запросе
-- к DC), поэтому хранится как есть.
--
-- Токен бота-приёмника лидов и настройки прогрева живут в app_settings
-- (ключи outreach.*), таблица уже существует.

CREATE TABLE IF NOT EXISTS outreach_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL DEFAULT '',
  api_id        integer NOT NULL,
  api_hash_enc  text NOT NULL,
  -- Сколько боевых аккаунтов допустимо повесить на этот ключ. Дефолт 20 —
  -- консервативно, чтобы не светить один app_id на слишком многих аккаунтах.
  max_accounts  integer NOT NULL DEFAULT 20,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_api_keys_status_check
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT outreach_api_keys_max_accounts_check
    CHECK (max_accounts > 0)
);
