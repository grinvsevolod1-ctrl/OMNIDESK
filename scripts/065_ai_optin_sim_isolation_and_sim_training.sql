-- Two-part AI overhaul: (A) strict per-dialog opt-in for the AI manager, plus
-- proper "Ликвид" handoff; (B) hard isolation + trainability for the client
-- simulator. The two systems remain 100% independent — nothing here couples
-- the manager brain to the simulator.
--
-- Safe to run multiple times.

/* =====================================================================
   PART A — AI MANAGER: STRICT PER-DIALOG OPT-IN
   =====================================================================

   Product change (reverts the 056 "lead everything" model):

     effective "AI is leading this conversation"
       = ai_assist_settings.enabled           -- master switch ON
         AND conversations.ai_enrolled         -- this dialog EXPLICITLY added
         AND NOT conversations.ai_paused        -- not temporarily paused
         AND NOT conversations.is_simulated     -- never a simulator dialog

   The AI now behaves like the simulator: it only ever participates in dialogs
   an admin has explicitly enrolled. Turning the master switch on no longer
   makes the AI seize existing or brand-new dialogs, and a server restart can
   never make it barge into an unrelated, previously-human dialog.

   Legacy columns kept for back-compat but no longer drive participation:
     - ai_autopilot_enabled (054)  — superseded by ai_enrolled
     - ai_paused (056)             — now a temporary pause ON TOP of enrollment
*/

-- Explicit per-conversation opt-in. Default false => AI touches nothing until
-- an admin enrolls the dialog from the Admin AI tab.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_enrolled boolean NOT NULL DEFAULT false;

-- When the dialog was enrolled (for ordering the "AI-led" list, newest first)
-- and audit ("since when has the AI been on this one").
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_enrolled_at timestamptz;

-- The message id at the moment of enrollment. The brain must only ever act on
-- messages AT OR AFTER this point, so enrolling an old dialog never makes the
-- AI "reply to" ancient backlog or drag the thread onto a stale topic.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_enrolled_from_message_id uuid;

-- Fast lookup of "which dialogs are AI-enrolled" for the schedulers/runtimes.
CREATE INDEX IF NOT EXISTS idx_conversations_ai_enrolled
  ON conversations(ai_enrolled_at DESC)
  WHERE ai_enrolled = true;

/* =====================================================================
   PART B — CLIENT SIMULATOR: ISOLATION + TRAINABILITY
   ===================================================================== */

-- Hard isolation flag. Every dialog the simulator creates is stamped true so
-- the normal manager inbox, analytics, and the AI manager can filter them out
-- with a plain column check (no fragile join to sim_threads). Real human
-- dialogs stay false forever. The AI manager must NEVER enroll a simulated
-- dialog, and the simulator must NEVER adopt a non-simulated one.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT false;

-- Backfill: any conversation already driven by the simulator is simulated.
UPDATE conversations c
   SET is_simulated = true
  FROM sim_threads t
 WHERE t.conversation_id = c.id
   AND c.is_simulated = false;

-- Partial index so "hide simulated" filters in the hot inbox path stay cheap.
CREATE INDEX IF NOT EXISTS idx_conversations_is_simulated
  ON conversations(id)
  WHERE is_simulated = true;

-- Simulator training corpus — the mirror of ai_manual_corrections (063), but
-- for teaching the SIMULATOR how a believable new human should write. In the
-- secret panel the admin selects any simulator message and writes "here you're
-- wrong — don't do this / do that instead". These are STRICT, ALWAYS-ON rules
-- injected into every simulator generation prompt. Kept entirely separate from
-- the manager's corpus so the two AIs never share knowledge.
--
-- No FK to conversations/channels on purpose (same durability rationale as
-- ai_manual_corrections): teaching survives even if the sim dialog is purged.
CREATE TABLE IF NOT EXISTS sim_manual_corrections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Optional, DANGLING-ALLOWED back-link for the UI only.
  conversation_id uuid,
  -- Short speaker-labelled transcript window ending on the selected message.
  context         text NOT NULL DEFAULT '',
  -- The exact simulator message text the admin flagged (quoted verbatim).
  target_message  text NOT NULL DEFAULT '',
  -- The admin's rule: what was wrong and what a real person would do instead.
  instruction     text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sim_manual_corrections_recent
  ON sim_manual_corrections(created_at DESC);
