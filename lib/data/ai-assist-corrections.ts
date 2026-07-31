import 'server-only'
import { query } from '../db'
import type { MediaType } from '../types'
import { mediaPlaceholder, type TrainingSample } from './ai-assist-shared'

/**
 * AI-assist corrections & review data layer, extracted from the ai-assist
 * monolith and re-exported from it for backward compatibility. Covers the
 * interactive per-message review dialogs, the manual corrections store /
 * correction rules, and training-conversation sampling.
 */

/* ------------------- Interactive per-message corrections ------------------ */

/** A dialog of an account, listed for the admin review/correction UI. */
export interface ReviewDialog {
  conversationId: string
  contactName: string
  lastMessageAt: string
  messageCount: number
  /** True when the AI is currently leading this thread (badge only). */
  aiLed: boolean
}

/**
 * All two-way dialogs of an account for the review UI, newest-first. These are
 * the conversations where a real back-and-forth happened (client + our side),
 * i.e. where the AI manager did — or could have — handled the client.
 */
export async function listAccountReviewDialogs(
  channelId: string,
  limit = 500,
): Promise<ReviewDialog[]> {
  const rows = await query<{
    id: string
    contact_name: string
    contact_name_hidden: boolean | null
    last_message_at: string | Date
    message_count: string
    ai_led: boolean
  }>(
    `SELECT conv.id,
            conv.contact_name,
            conv.contact_name_hidden,
            conv.last_message_at,
            COUNT(m.id)::text AS message_count,
            (s.enabled AND conv.ai_enrolled AND NOT conv.ai_paused) AS ai_led
       FROM conversations conv
       JOIN messages m ON m.conversation_id = conv.id
                       AND m.deleted_at IS NULL AND m.body <> ''
       CROSS JOIN ai_assist_settings s
      WHERE conv.channel_id = $1 AND s.id = true
      GROUP BY conv.id, conv.contact_name, conv.contact_name_hidden,
               conv.last_message_at, s.enabled, conv.ai_enrolled,
               conv.ai_paused
     HAVING COUNT(*) FILTER (WHERE m.direction = 'in')  > 0
        AND COUNT(*) FILTER (WHERE m.direction = 'out') > 0
      ORDER BY conv.last_message_at DESC
      LIMIT $2`,
    [channelId, Math.max(1, Math.min(2000, limit))],
  )
  return rows.map((r) => ({
    conversationId: r.id,
    contactName: r.contact_name_hidden ? 'Скрыт' : r.contact_name,
    lastMessageAt: new Date(r.last_message_at).toISOString(),
    messageCount: Number(r.message_count ?? 0),
    aiLed: Boolean(r.ai_led),
  }))
}

/** One message inside the review pane. */
export interface ReviewMessage {
  id: string
  role: 'client' | 'ai' | 'manager'
  author: string
  body: string
  mediaType: MediaType | null
  createdAt: string
}

/**
 * The full message list of a dialog for the review pane, oldest→newest, scoped
 * to the given channel so an admin can only open dialogs of the account they
 * picked. Media-only turns are kept with a placeholder body.
 */
export async function getDialogMessagesForReview(
  channelId: string,
  conversationId: string,
): Promise<ReviewMessage[]> {
  const rows = await query<{
    id: string
    direction: 'in' | 'out'
    author: string
    body: string
    media_type: MediaType | null
    created_at: string | Date
  }>(
    `SELECT m.id, m.direction, m.author, m.body, m.media_type, m.created_at
       FROM messages m
       JOIN conversations conv ON conv.id = m.conversation_id
      WHERE m.conversation_id = $1
        AND conv.channel_id = $2
        AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT 500`,
    [conversationId, channelId],
  )
  return rows.map((r) => {
    // Outbound rows authored by the assistant carry the 'ИИ-ассистент' label
    // (see autopilot runtime); everything else outbound is a human manager.
    const isAi = r.direction === 'out' && /ИИ|ассистент|\bAI\b/i.test(r.author)
    return {
      id: r.id,
      role: r.direction === 'in' ? 'client' : isAi ? 'ai' : 'manager',
      author: r.author,
      body: r.body.trim() || mediaPlaceholder(r.media_type),
      mediaType: r.media_type,
      createdAt: new Date(r.created_at).toISOString(),
    }
  })
}

/* ------------------------ Manual corrections store ------------------------ */

/** A hand-written correction the admin taught the AI on a specific message. */
export interface ManualCorrection {
  id: string
  createdAt: string
  conversationId: string | null
  accountLabel: string
  context: string
  targetRole: 'client' | 'ai' | 'manager'
  targetMessage: string
  instruction: string
}

interface ManualCorrectionRow {
  id: string
  created_at: string | Date
  conversation_id: string | null
  account_label: string
  context: string
  target_role: string
  target_message: string
  instruction: string
}

function mapManualCorrection(r: ManualCorrectionRow): ManualCorrection {
  const role = r.target_role
  return {
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    conversationId: r.conversation_id,
    accountLabel: r.account_label ?? '',
    context: r.context ?? '',
    targetRole: role === 'client' || role === 'manager' ? role : 'ai',
    targetMessage: r.target_message ?? '',
    instruction: r.instruction ?? '',
  }
}

/** Persist one manual correction (kept forever; survives account deletion). */
export async function addManualCorrection(input: {
  conversationId: string | null
  channelId: string | null
  accountLabel: string
  context: string
  targetRole: 'client' | 'ai' | 'manager'
  targetMessage: string
  instruction: string
}): Promise<ManualCorrection> {
  const rows = await query<ManualCorrectionRow>(
    `INSERT INTO ai_manual_corrections
       (conversation_id, channel_id, account_label, context, target_role, target_message, instruction)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at, conversation_id, account_label, target_role, target_message, context, instruction`,
    [
      input.conversationId,
      input.channelId,
      input.accountLabel,
      input.context,
      input.targetRole,
      input.targetMessage,
      input.instruction,
    ],
  )
  return mapManualCorrection(rows[0])
}

/** All manual corrections, newest-first (management UI). */
export async function listManualCorrections(
  limit = 200,
): Promise<ManualCorrection[]> {
  const rows = await query<ManualCorrectionRow>(
    `SELECT id, created_at, conversation_id, account_label, target_role, target_message, context, instruction
       FROM ai_manual_corrections
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(1000, limit))],
  )
  return rows.map(mapManualCorrection)
}

/**
 * Manual corrections rendered as strict, ready-to-inject rule strings for the
 * brain. Newest-first and generously capped — these are always injected and
 * never distilled away, so the AI never forgets a correction.
 */
export async function listManualCorrectionRules(
  limit = 60,
): Promise<string[]> {
  const rows = await query<{
    context: string
    target_role: string
    target_message: string
    instruction: string
  }>(
    `SELECT context, target_role, target_message, instruction
       FROM ai_manual_corrections
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(200, limit))],
  )
  return rows.map((r) => {
    const who =
      r.target_role === 'client'
        ? 'сообщение клиента'
        : r.target_role === 'manager'
          ? 'сообщение менеджера'
          : 'твой ответ'
    const quoted = r.target_message.trim()
    const ctx = r.context.trim()
    const parts: string[] = []
    if (ctx) parts.push(`В ситуации:\n${ctx}`)
    if (quoted) parts.push(`Разбираем ${who}: «${quoted}».`)
    parts.push(`ПРАВИЛО: ${r.instruction.trim()}`)
    return parts.join(' ')
  })
}

export async function deleteManualCorrection(id: string): Promise<void> {
  await query(`DELETE FROM ai_manual_corrections WHERE id = $1`, [id])
}

export async function countManualCorrections(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_manual_corrections`,
  )
  return Number(rows[0]?.n ?? 0)
}

export async function sampleTrainingConversations(
  limit = 8,
): Promise<TrainingSample[]> {
  // Newest conversations whose latest message is inbound (awaiting a reply).
  const convs = await query<{ id: string }>(
    `SELECT c.id
       FROM conversations c
       JOIN LATERAL (
         SELECT direction FROM messages m
          WHERE m.conversation_id = c.id AND m.deleted_at IS NULL AND m.body <> ''
          ORDER BY m.created_at DESC LIMIT 1
       ) last ON true
      WHERE last.direction = 'in'
      ORDER BY c.last_message_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(20, limit))],
  )

  const samples: TrainingSample[] = []
  for (const c of convs) {
    const rows = await query<{ direction: 'in' | 'out'; body: string }>(
      `SELECT direction, body FROM messages
        WHERE conversation_id = $1 AND deleted_at IS NULL AND body <> ''
        ORDER BY created_at DESC LIMIT 12`,
      [c.id],
    )
    const history = rows
      .reverse()
      .map((r) => ({
        role: (r.direction === 'in' ? 'client' : 'manager') as
          | 'client'
          | 'manager',
        body: r.body,
      }))
    const lastClient = [...history].reverse().find((m) => m.role === 'client')
    if (!lastClient) continue
    samples.push({
      conversationId: c.id,
      lastClientMessage: lastClient.body,
      history,
    })
  }
  return samples
}
