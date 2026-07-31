-- Follow-up autopilot: chat-configured, OFF by default.
--
-- The AI manager can gently re-engage clients who went silent, across every
-- channel. All of it is driven from the co-pilot chat (nothing hardcoded) and
-- nothing is ever sent until an admin explicitly enables it here.
--
-- ISOLATION: these tables have NO relationship to the simulator or god panel.
-- The follow-up runtime only ever reads real conversations (is_simulated=false)
-- and never touches client-sim/god-gate data.

-- Singleton settings row (id is always true), mirroring ai_assist_settings.
CREATE TABLE IF NOT EXISTS ai_followup_settings (
  id            BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  -- Master switch for follow-up. OFF by default: the AI never nudges anyone
  -- until an admin turns this on through the co-pilot chat.
  enabled       BOOLEAN NOT NULL DEFAULT false,
  -- How long a client must be silent (since the last message in the thread)
  -- before the first nudge is allowed.
  delay_hours   INTEGER NOT NULL DEFAULT 24 CHECK (delay_hours BETWEEN 1 AND 720),
  -- Maximum number of nudges per silence streak, so we never spam a client.
  max_touches   INTEGER NOT NULL DEFAULT 2 CHECK (max_touches BETWEEN 1 AND 5),
  -- Quiet hours (local to quiet_tz): no nudges are sent inside [start, end).
  -- Overnight windows (end <= start) are supported by the runtime.
  quiet_start   INTEGER NOT NULL DEFAULT 21 CHECK (quiet_start BETWEEN 0 AND 23),
  quiet_end     INTEGER NOT NULL DEFAULT 9  CHECK (quiet_end   BETWEEN 0 AND 23),
  quiet_tz      TEXT    NOT NULL DEFAULT 'Europe/Moscow',
  -- Which channels follow-up is allowed on (subset of the supported set).
  channels      JSONB   NOT NULL DEFAULT '["livechat","whatsapp","vk","max","telegram"]'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ai_followup_settings (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;

-- One row per nudge actually sent. Drives both the per-streak touch cap and the
-- dedup guard (never nudge twice for the same silence).
CREATE TABLE IF NOT EXISTS ai_followup_touches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- The message row this nudge produced (for auditing / linking).
  message_id      UUID,
  -- 1-based index of this nudge within the current silence streak.
  touch_no        INTEGER NOT NULL DEFAULT 1,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_followup_touches_conv_idx
  ON ai_followup_touches (conversation_id, sent_at DESC);
