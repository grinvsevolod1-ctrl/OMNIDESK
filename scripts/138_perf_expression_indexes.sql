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

-- Партиальный предикат — только IS NOT NULL: его планировщик умеет выводить
-- из равенства по строгому выражению. Условие «<> ''» в предикате сделало бы
-- индекс недоказуемым и он бы просто не использовался.
CREATE INDEX IF NOT EXISTS idx_lead_cards_tg_username_norm
  ON lead_cards (lower(regexp_replace(telegram_username, '^@', '')))
  WHERE telegram_username IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lead_cards_phone_digits
  ON lead_cards (regexp_replace(phone, '\D', '', 'g'))
  WHERE phone IS NOT NULL;

-- Тот же матчинг смотрит и в conversations по нормализованному юзернейму
-- (ветка OR через LEFT JOIN oc): индекс по выражению ускоряет её,
-- когда планировщик выбирает index scan по oc.
-- Без партиального предиката: запрос оборачивает колонку в coalesce(...,''),
-- из такого выражения планировщик не выведет «contact_username IS NOT NULL»,
-- и партиальный индекс остался бы неиспользуемым.
CREATE INDEX IF NOT EXISTS idx_conversations_username_norm
  ON conversations (lower(regexp_replace(coalesce(contact_username, ''), '^@', '')));

-- И по цифрам телефона в contact_handle (ветка whatsapp/телефонного матчинга
-- в том же запросе: regexp_replace(oc.contact_handle, '\D', '', 'g') = $3).
CREATE INDEX IF NOT EXISTS idx_conversations_handle_digits
  ON conversations (regexp_replace(contact_handle, '\D', '', 'g'))
  WHERE contact_handle IS NOT NULL;
