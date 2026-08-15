-- 138: expression-индексы под горячий матчинг лид-карточек к диалогам.
--
-- findLeadCardByContact (lib/data/lead-cards-queries.ts) матчит карточку
-- по НОРМАЛИЗОВАННЫМ выражениям:
--   lower(regexp_replace(telegram_username, '^@', ''))  — юзернейм без @
--   regexp_replace(phone, '\D', '', 'g')                — только цифры
-- Обычные btree/trgm-индексы по колонкам эти выражения не покрывают:
-- планировщик делает Seq Scan по lead_cards на КАЖДОЕ открытие диалога
-- в инбоксе. Expression-индексы дают точный index lookup.
--
-- NB: без CONCURRENTLY — deploy.sh применяет миграции до свапа кода,
-- кратковременный лок на lead_cards при деплое приемлем (как и в
-- остальных миграциях проекта). Идемпотентно через IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_lead_cards_tg_username_norm
  ON lead_cards (lower(regexp_replace(telegram_username, '^@', '')))
  WHERE telegram_username IS NOT NULL AND telegram_username <> '';

CREATE INDEX IF NOT EXISTS idx_lead_cards_phone_digits
  ON lead_cards (regexp_replace(phone, '\D', '', 'g'))
  WHERE phone IS NOT NULL AND phone <> '';

-- Тот же матчинг смотрит и в conversations по нормализованному юзернейму
-- (ветка OR через LEFT JOIN oc): индекс по выражению ускоряет её,
-- когда планировщик выбирает index scan по oc.
CREATE INDEX IF NOT EXISTS idx_conversations_username_norm
  ON conversations (lower(regexp_replace(coalesce(contact_username, ''), '^@', '')))
  WHERE contact_username IS NOT NULL AND contact_username <> '';
