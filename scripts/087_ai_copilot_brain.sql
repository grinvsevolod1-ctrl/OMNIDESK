-- Co-pilot "brains" upgrade: durable business memory + seller regression cases.
--
-- Both tables belong to the ADMIN co-pilot (the chat the admin talks to),
-- not to the customer-facing manager brain:
--
-- 1. ai_copilot_notes — long-term memory about the admin's business. The chat
--    history is trimmed to the last N turns, so anything important the admin
--    tells the co-pilot ("у нас сезонный бизнес, пик в декабре") used to be
--    forgotten. Notes persist and are loaded into every co-pilot turn.
--
-- 2. ai_check_cases — saved "проверочные вопросы" for the seller. After the
--    admin changes rules/persona, the co-pilot can re-run these client
--    messages through the real seller brain and flag regressions ("правило
--    применилось, но сломало ответ на возражение по цене").

CREATE TABLE IF NOT EXISTS ai_copilot_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The remembered fact, in the admin's own words (lightly tidied).
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_copilot_notes_created
  ON ai_copilot_notes(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_check_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the "client" says in the test.
  client_message  text NOT NULL CHECK (char_length(client_message) BETWEEN 1 AND 2000),
  -- What a GOOD reply must do, in plain words ("должен предложить рассрочку").
  expectation     text NOT NULL CHECK (char_length(expectation) BETWEEN 1 AND 1000),
  -- Paused cases are kept but skipped by runs.
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_check_cases_enabled
  ON ai_check_cases(enabled, created_at DESC);
