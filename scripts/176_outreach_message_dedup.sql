-- 176 — Идемпотентный приём ответов лида в исходящем контуре.
--
-- Reply-поллер воркера (worker/src/outreach-warmup-runner.ts) тянет свежую
-- историю MTProto по открытым тредам и добавляет входящие в outreach_messages.
-- Чтобы один и тот же ответ не задвоился между тиками, вставка идёт через
-- ON CONFLICT DO NOTHING по (lead_id, provider_msg_id) — этому нужен частичный
-- уникальный индекс (provider_msg_id у исходящих/старых строк может быть NULL).

CREATE UNIQUE INDEX IF NOT EXISTS outreach_messages_provider_uniq
  ON outreach_messages (lead_id, provider_msg_id)
  WHERE provider_msg_id IS NOT NULL;
