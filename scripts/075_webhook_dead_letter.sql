-- 075_webhook_dead_letter.sql
--
-- Durable dead-letter queue for inbound webhook messages that failed to ingest.
--
-- Before this, a transient DB error while handling a VK/MAX webhook meant the
-- inbound message was ACKed (or 500'd) and effectively LOST — only a pm2 log
-- line remained. This table persists the normalized inbound so a background
-- retry loop can replay it into the inbox with exponential backoff, and so
-- messages that never succeed are visible/queryable instead of vanishing.
--
-- `payload` holds the exact normalized argument object passed to
-- recordVkInbound / recordMaxInbound (contactName, body, media refs, provider
-- message id, …). The channel pool + fallback manager are intentionally NOT
-- stored there: they are re-resolved from the live channel at replay time so a
-- reassigned pool or a manager who went offline is handled correctly.

CREATE TABLE IF NOT EXISTS webhook_dead_letter (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which provider + channel this inbound belongs to (drives replay dispatch).
  channel_type        TEXT NOT NULL CHECK (channel_type IN ('vk', 'max')),
  channel_id          UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- The contact + provider message id, surfaced as columns for dedupe/search.
  contact_handle      TEXT NOT NULL,
  provider_message_id TEXT,
  -- Normalized recordXInbound argument object (minus pool/fallbackManagerId).
  payload             JSONB NOT NULL,
  -- Retry bookkeeping.
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'resolved', 'failed')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 12,
  last_error          TEXT,
  next_retry_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);

-- The retry loop claims "pending rows whose next_retry_at is due", oldest first.
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letter_due
  ON webhook_dead_letter (next_retry_at)
  WHERE status = 'pending';

-- Fast lookups when inspecting a channel's failures in the god panel.
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letter_channel
  ON webhook_dead_letter (channel_id, status, created_at DESC);

-- Idempotency: don't stack duplicate dead-letters for the same provider message
-- while it is still pending (webhooks can re-deliver). Partial unique index so
-- resolved/failed history rows don't block a genuinely new failure later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_dead_letter_pending
  ON webhook_dead_letter (channel_id, provider_message_id)
  WHERE status = 'pending' AND provider_message_id IS NOT NULL;
