import 'server-only'
import { query } from '../db'

/**
 * AI enrollment (which dialogs the AI leads), pause/resume, and AI→human
 * handoffs. Split out of ai-assist.ts (which remains the barrel).
 */

/**
 * True when the AI is effectively leading this conversation:
 *
 *   led = ai_assist_settings.enabled      -- master switch ON
 *         AND conversations.ai_enrolled    -- this dialog is AI-led
 *         AND NOT conversations.ai_paused   -- not temporarily paused
 *         AND conversations.curator_id IS NULL  -- not handed to a curator
 *
 * New dialogs are auto-enrolled at creation, so the AI leads them out of the
 * box; pre-existing dialogs stay manual until an admin enrolls them. A single
 * CROSS JOIN keeps this cheap.
 *
 * curator_id gate (миграция 151): как только лид передан куратору, диалог ведёт
 * куратор вручную — ИИ менеджера замолкает независимо от enrollment. Формула
 * ДОЛЖНА совпадать с worker/src/repo-ai-context.ts#isConversationAiLed.
 */
export async function isConversationAiLed(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ led: boolean }>(
    `SELECT (s.enabled AND c.ai_enrolled AND NOT c.ai_paused
             AND c.curator_id IS NULL) AS led
       FROM conversations c
       CROSS JOIN ai_assist_settings s
      WHERE c.id = $1 AND s.id = true`,
    [conversationId],
  )
  return Boolean(rows[0]?.led)
}

/**
 * Manager pauses/resumes the AI for a single ENROLLED conversation (a temporary
 * opt-out on top of enrollment — e.g. to take over by hand for a moment without
 * un-enrolling). Manager-scoped. Returns the new paused state, or null when not
 * owned.
 */
export async function setConversationAiPaused(
  conversationId: string,
  managerId: string,
  paused: boolean,
): Promise<boolean | null> {
  const rows = await query<{ ai_paused: boolean }>(
    `UPDATE conversations
        SET ai_paused = $3
      WHERE id = $1 AND manager_id = $2
      RETURNING ai_paused`,
    [conversationId, managerId, paused],
  )
  return rows[0] ? rows[0].ai_paused : null
}

/** One dialog in the AI-enrollment picker / enrolled list. */
export interface EnrollableConversation {
  conversationId: string
  contactName: string
  channelType: string
  lastMessage: string
  lastAt: string
  enrolled: boolean
}

function mapEnrollable(r: {
  id: string
  contact_name: string
  contact_name_hidden: boolean | null
  channel_type: string
  last_body: string | null
  last_at: string | Date | null
  ai_enrolled: boolean
}): EnrollableConversation {
  return {
    conversationId: r.id,
    contactName: r.contact_name_hidden ? 'Скрыт' : r.contact_name,
    channelType: r.channel_type,
    lastMessage: (r.last_body ?? '').slice(0, 120),
    lastAt: r.last_at ? new Date(r.last_at).toISOString() : '',
    enrolled: r.ai_enrolled,
  }
}

/**
 * Dialogs the admin can enroll the AI into, newest-active first. Optional text
 * search over contact name.
 */
export async function listEnrollableConversations(
  search: string,
  limit = 50,
): Promise<EnrollableConversation[]> {
  const like = `%${search.trim()}%`
  const rows = await query<Parameters<typeof mapEnrollable>[0]>(
    `SELECT c.id, c.contact_name, c.contact_name_hidden, c.channel_type,
            c.ai_enrolled,
            m.body AS last_body, m.created_at AS last_at
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM messages
          WHERE conversation_id = c.id AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1
       ) m ON true
      WHERE ($1 = '%%' OR c.contact_name ILIKE $1)
      ORDER BY m.created_at DESC NULLS LAST
      LIMIT $2`,
    [like, Math.max(1, Math.min(200, limit))],
  )
  return rows.map(mapEnrollable)
}

/** Dialogs currently enrolled (AI-led), newest enrollment first. */
export async function listAiEnrolledConversations(
  limit = 200,
): Promise<EnrollableConversation[]> {
  const rows = await query<Parameters<typeof mapEnrollable>[0]>(
    `SELECT c.id, c.contact_name, c.contact_name_hidden, c.channel_type,
            c.ai_enrolled,
            m.body AS last_body, m.created_at AS last_at
       FROM conversations c
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM messages
          WHERE conversation_id = c.id AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1
       ) m ON true
      WHERE c.ai_enrolled = true
      ORDER BY c.ai_enrolled_at DESC NULLS LAST
      LIMIT $1`,
    [Math.max(1, Math.min(500, limit))],
  )
  return rows.map(mapEnrollable)
}

/**
 * Enroll the AI into a dialog (opt-in). Stamps the enrollment time and the
 * current latest message as the cutoff, so the brain only ever acts on messages
 * from now on and never replays the old backlog / drifts off-topic. Returns
 * true when it enrolled.
 */
export async function enrollConversationAi(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations c
        SET ai_enrolled = true,
            ai_paused = false,
            ai_enrolled_at = now(),
            ai_enrolled_from_message_id = (
              SELECT id FROM messages
               WHERE conversation_id = c.id AND deleted_at IS NULL
               ORDER BY created_at DESC LIMIT 1
            )
      WHERE c.id = $1
      RETURNING c.id`,
    [conversationId],
  )
  return rows.length > 0
}

/** Remove the AI from a dialog (un-enroll). Human fully takes back over. */
export async function unenrollConversationAi(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET ai_enrolled = false,
            ai_handoff_pending = false
      WHERE id = $1
      RETURNING id`,
    [conversationId],
  )
  return rows.length > 0
}

/**
 * The AI hands the dialogue to a human and moves the lead to «Передан человеку»
 * ('handoff'). Called by the AI runtimes (worker + live-chat) — UNSCOPED, no
 * manager session. Only promotes when the lead still has its default status, so
 * a manual «Ликвид»/«Не ликвид»/«Передан» classification is never clobbered.
 * The AI never assigns «Ликвид» itself — that's a manager-only decision. Also
 * pauses the AI so the human takes over cleanly, and flags a pending handoff for
 * the inbox banner. Returns true when it actually promoted (so the caller can
 * log it once).
 */
export async function markAiHandoffToHuman(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET status = 'handoff',
            status_detail = NULL,
            status_updated_at = now(),
            ai_paused = true,
            ai_handoff_pending = true,
            ai_handoff_at = now()
      WHERE id = $1
        AND COALESCE(status, 'unsubscribed') = 'unsubscribed'
      RETURNING id`,
    [conversationId],
  )
  return rows.length > 0
}

/** A pending AI→human handoff surfaced in the manager inbox banner. */
export interface AiHandoff {
  conversationId: string
  contactName: string
  channelType: string
  at: string
}

/** Pending handoffs for a manager, newest first (drives the banner + highlight). */
export async function listPendingAiHandoffs(
  managerId: string,
): Promise<AiHandoff[]> {
  const rows = await query<{
    id: string
    contact_name: string
    contact_name_hidden: boolean | null
    channel_type: string
    ai_handoff_at: string | Date | null
  }>(
    `SELECT id, contact_name, contact_name_hidden, channel_type, ai_handoff_at
       FROM conversations
      WHERE manager_id = $1 AND ai_handoff_pending = true
      ORDER BY ai_handoff_at DESC NULLS LAST
      LIMIT 50`,
    [managerId],
  )
  return rows.map((r) => ({
    conversationId: r.id,
    contactName: r.contact_name_hidden ? 'Скрыт' : r.contact_name,
    channelType: r.channel_type,
    at: r.ai_handoff_at ? new Date(r.ai_handoff_at).toISOString() : '',
  }))
}

/**
 * Manager acknowledges a handoff (opened the thread): clears the pending flag
 * so the banner/highlight goes away. Manager-scoped. Returns true when cleared.
 */
export async function acknowledgeAiHandoff(
  conversationId: string,
  managerId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET ai_handoff_pending = false
      WHERE id = $1 AND manager_id = $2 AND ai_handoff_pending = true
      RETURNING id`,
    [conversationId, managerId],
  )
  return rows.length > 0
}
