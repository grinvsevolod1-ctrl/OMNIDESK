-- Autopilot: per-manager auto-reply rules.
--
-- Each manager builds a personal set of rules that automatically reply to
-- incoming messages across ALL of their sources (live-chat widget, Telegram,
-- WhatsApp). A rule fires when its EVENT happens AND every configured CONDITION
-- matches. Auto-replies are sent instantly for live-chat and with human-like
-- pacing + per-channel rate limits for messengers (anti-ban).
--
-- Scoped per manager: settings, rules and fire-history all belong to exactly
-- one manager and are never shared. A master on/off switch lives in
-- autopilot_settings so the manager can pause everything from the inbox.
--
-- Safe to run multiple times.

-- Master switch (+ room for future global limits) — one row per manager.
CREATE TABLE IF NOT EXISTS autopilot_settings (
  manager_id  uuid PRIMARY KEY REFERENCES managers(id) ON DELETE CASCADE,
  -- Global kill switch. When false NO rule fires, regardless of rule.enabled.
  enabled     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS autopilot_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id  uuid NOT NULL REFERENCES managers(id) ON DELETE CASCADE,
  -- Human label shown in the UI (e.g. "Приветствие новым клиентам").
  name        text NOT NULL DEFAULT '',
  -- Per-rule enable, independent of the master switch.
  enabled     boolean NOT NULL DEFAULT true,
  -- Manual priority/ordering (lower = evaluated earlier). Only the first
  -- matching rule per incoming message fires, so order decides precedence.
  sort_order  integer NOT NULL DEFAULT 0,
  -- Trigger EVENT (exactly one per rule):
  --   'first_message' = first ever inbound in a conversation (once per conv)
  --   'any_message'   = every inbound (subject to cooldown)
  --   'no_response'   = inbound left unanswered by a human for N minutes
  event       text NOT NULL DEFAULT 'first_message',
  -- CONDITION filters + reply payload, all in one jsonb blob so the rule shape
  -- can evolve without migrations. Shape (see lib/autopilot/match.ts):
  --   {
  --     "sources": string[],            // channel ids; [] = all sources
  --     "keywords": string[],           // [] = no keyword filter
  --     "keywordMatch": "any"|"all",
  --     "requireWorkingHours": "any"|"inside"|"outside",
  --     "noResponseMinutes": number,    // only for event = 'no_response'
  --     "replyText": string,            // the message to auto-send
  --     "delaySec": number,             // base anti-ban delay (messengers)
  --     "oncePerConversation": boolean  // dedupe via autopilot_fires
  --   }
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_autopilot_rules_manager
  ON autopilot_rules(manager_id, sort_order, created_at);

-- Fire history: one row per (rule, conversation) the first time that rule fires
-- on that conversation. Powers dedupe for 'first_message' / 'oncePerConversation'
-- and stops 'no_response' from re-sending. CASCADE so deleting a rule clears it.
CREATE TABLE IF NOT EXISTS autopilot_fires (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid NOT NULL REFERENCES autopilot_rules(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_autopilot_fires_conversation
  ON autopilot_fires(conversation_id);

-- Mark outbound messages that were sent by autopilot (vs. a human). Lets the
-- worker enforce per-channel anti-ban rate caps by counting only auto-sends,
-- and lets the UI badge auto-replies. Defaults false for all existing rows.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_autopilot boolean NOT NULL DEFAULT false;

-- Partial index to make the trailing-window rate-cap count cheap.
CREATE INDEX IF NOT EXISTS idx_messages_autopilot_recent
  ON messages(conversation_id, created_at)
  WHERE is_autopilot = true;
