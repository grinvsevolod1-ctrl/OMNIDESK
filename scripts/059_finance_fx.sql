-- Заморозка курса валют для расходов.
--
-- Теперь суммы расходов хранятся в USD (колонка amount), а исходная сумма и
-- валюта ввода фиксируются вместе с курсом на момент добавления. Пересчёта
-- задним числом не происходит — amount уже в USD.
--
--   orig_amount   — сумма в валюте, которую ввёл администратор;
--   orig_currency — валюта ввода (USDT | RUB | USD | EUR);
--   fx_rate       — сколько USD стоила 1 единица orig_currency на тот момент.
--   amount = orig_amount * fx_rate (в USD).

ALTER TABLE finance_entries
  ADD COLUMN IF NOT EXISTS orig_amount   numeric(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS orig_currency text           NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS fx_rate       numeric(18, 8) NOT NULL DEFAULT 1;

-- Бэкофилл существующих записей: считаем, что сумма уже была в валюте ресурса,
-- курс 1:1 (исторический курс восстановить нельзя). Значение amount не трогаем.
UPDATE finance_entries e
   SET orig_amount   = e.amount,
       orig_currency = COALESCE(r.currency, 'USD'),
       fx_rate       = 1
  FROM finance_resources r
 WHERE e.resource_id = r.id
   AND e.orig_amount = 0
   AND e.amount <> 0;

-- Новым ресурсам валюта больше не назначается вручную — суммы ведём в USD.
ALTER TABLE finance_resources ALTER COLUMN currency SET DEFAULT 'USD';
