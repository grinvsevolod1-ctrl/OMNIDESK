-- Client simulator ("god-mode" QA bot) — 100% invisible to managers.
--
-- The bot drives REAL conversations through the exact same
-- conversations/messages tables & triggers a genuine incoming chat uses, so a
-- manager can never tell them apart. All bot-only metadata lives in the two
-- tables below, which NOTHING in the manager inbox or the god-console
-- conversation rail ever joins — that is what keeps the simulation invisible.
--
--   sim_settings  — single-row control panel (enabled, channels, cadence, tone)
--   sim_threads   — one row per conversation the bot drives (persona, mood,
--                   state machine, next-run schedule)
--
-- Safe to run multiple times.

/* ------------------------------ sim_settings ---------------------------- */

CREATE TABLE IF NOT EXISTS sim_settings (
  id            boolean PRIMARY KEY DEFAULT true,      -- singleton guard row
  enabled       boolean NOT NULL DEFAULT false,
  -- channels the bot is allowed to open conversations on (empty = none)
  channel_ids   uuid[]  NOT NULL DEFAULT '{}',
  -- how vulgar/aggressive personas skew overall, 0..100
  aggression    integer NOT NULL DEFAULT 60,
  -- how many concurrent live bot threads to maintain
  max_threads   integer NOT NULL DEFAULT 6,
  -- new-thread creation cadence bounds (seconds). Defaults model ~10 new
  -- conversations per hour with heavy jitter (avg ≈ one every 6 min), so it
  -- reads like organic traffic rather than a clock.
  spawn_min_sec integer NOT NULL DEFAULT 180,
  spawn_max_sec integer NOT NULL DEFAULT 576,
  -- human-like delay before a bot reacts to a manager reply (seconds)
  reply_min_sec integer NOT NULL DEFAULT 20,
  reply_max_sec integer NOT NULL DEFAULT 180,
  -- when the engine is next allowed to spawn a thread (atomic spawn slot)
  next_spawn_at timestamptz,
  -- lifetime counters for the dashboard (never reset automatically)
  spawned_total integer NOT NULL DEFAULT 0,
  replies_total integer NOT NULL DEFAULT 0,
  started_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sim_settings_singleton CHECK (id)
);

INSERT INTO sim_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Keep column defaults in sync when re-running on an older install (only
-- affects future inserts; never rewrites an existing settings row).
ALTER TABLE sim_settings ALTER COLUMN max_threads   SET DEFAULT 6;
ALTER TABLE sim_settings ALTER COLUMN spawn_min_sec SET DEFAULT 180;
ALTER TABLE sim_settings ALTER COLUMN spawn_max_sec SET DEFAULT 576;
ALTER TABLE sim_settings ALTER COLUMN reply_min_sec SET DEFAULT 20;
ALTER TABLE sim_settings ALTER COLUMN reply_max_sec SET DEFAULT 180;

/* ------------------------------- sim_threads ---------------------------- */

CREATE TABLE IF NOT EXISTS sim_threads (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id      uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- persona + style + mood, generated once at spawn
  persona         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- state machine: opening | chatting | ignoring | done
  state           text  NOT NULL DEFAULT 'opening',
  turns           integer NOT NULL DEFAULT 0,
  -- id of the last manager (out) message this thread already reacted to,
  -- so we never double-reply to the same manager message
  last_seen_out   uuid,
  -- when the engine should next act on this thread (NULL = waiting on manager)
  next_run_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sim_threads_due
  ON sim_threads(next_run_at)
  WHERE state <> 'done';

CREATE INDEX IF NOT EXISTS idx_sim_threads_state ON sim_threads(state);
