import { query, one } from './db.js'
import {
  embedText,
  toVectorLiteral,
  understandMedia,
} from '../../lib/ai/manager-brain.js'
import { getStoredMediaBytes } from './repo-media.js'

/**
 * Brain-input context for the worker: correction lessons, manual correction
 * rules, AI-led / handoff bookkeeping, RAG knowledge retrieval, durable
 * conversation memory, and the AI transcript builder (with media
 * understanding).
 */

/** One correction lesson in the shape the pure brain expects. */
export interface AiAssistLessonLite {
  situation: string
  corrected: string
  note: string
}

/** Most recent correction lessons for prompt injection. */
export async function listAiLessons(
  limit = 12,
): Promise<AiAssistLessonLite[]> {
  // Exclude source='auto' lessons: those are produced by the training
  // simulator's self-play scoring and must never train the real manager.
  // Kept in sync with lib/data/ai-assist.ts#listBrainLessons.
  return query<AiAssistLessonLite>(
    `SELECT situation, corrected, note
       FROM ai_assist_lessons
      WHERE source IS DISTINCT FROM 'auto'
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(50, limit))],
  )
}

/**
 * Strict manual corrections rendered as always-inject rule strings (newest
 * first). Kept in sync with lib/data/ai-assist.ts#listManualCorrectionRules so
 * the worker's AI obeys the exact same hand-written corrections as the panel.
 * Tolerates the table being absent (pre-migration) by returning [].
 */
export async function listManualCorrectionRules(
  limit = 60,
): Promise<string[]> {
  try {
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
      const quoted = (r.target_message || '').trim()
      const ctx = (r.context || '').trim()
      const parts: string[] = []
      if (ctx) parts.push(`В ситуации:\n${ctx}`)
      if (quoted) parts.push(`Разбираем ${who}: «${quoted}».`)
      parts.push(`ПРАВИЛО: ${(r.instruction || '').trim()}`)
      return parts.join(' ')
    })
  } catch {
    return []
  }
}

/**
 * True when the AI is effectively leading THIS conversation — mirror of
 * lib/data/ai-assist.ts#isConversationAiLed so the worker and the panel agree
 * exactly:
 *
 *   led = ai_assist_settings.enabled AND c.ai_enrolled AND NOT c.ai_paused
 *         AND c.curator_id IS NULL
 *
 * curator_id gate (миграция 151): переданный куратору диалог ИИ не ведёт.
 */
export async function isConversationAiLed(
  conversationId: string,
): Promise<boolean> {
  const row = await one<{ led: boolean }>(
    `SELECT (s.enabled AND c.ai_enrolled AND NOT c.ai_paused
             AND c.curator_id IS NULL) AS led
       FROM conversations c
       CROSS JOIN ai_assist_settings s
      WHERE c.id = $1 AND s.id = true`,
    [conversationId],
  )
  return !!row?.led
}

/**
 * The AI hands the dialogue to a human and moves the lead to «Передан человеку»
 * ('handoff'). Only promotes when the lead still has its default status, pauses
 * the AI so the human takes over, and flags a pending handoff for the panel
 * banner. The AI never assigns «Ликвид» itself — that stays a manager-only
 * decision. Returns true when it actually promoted (mirror of the panel's
 * markAiHandoffToHuman).
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

/**
 * RAG retrieval for the worker: embed the query, find the nearest enabled
 * knowledge chunks, and return them as a compact block for the brain. Mirrors
 * lib/data/ai-assist.ts#retrieveKnowledge. Best-effort — returns '' on any
 * failure (no key, no embedding, no matches, pre-migration).
 */
export async function retrieveKnowledge(
  queryText: string,
  topK = 4,
): Promise<string> {
  try {
    const embedding = await embedText(queryText)
    if (!embedding) return ''
    const rows = await query<{ title: string; content: string; dist: number }>(
      `SELECT title, content, (embedding <=> $1::vector) AS dist
         FROM ai_knowledge
        WHERE enabled = true AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [toVectorLiteral(embedding), Math.max(1, Math.min(10, topK))],
    )
    const relevant = rows.filter((r) => Number(r.dist) < 0.55)
    if (relevant.length === 0) return ''
    return relevant
      .map((r) => (r.title ? `• ${r.title}: ${r.content}` : `• ${r.content}`))
      .join('\n')
  } catch {
    return ''
  }
}

/** Read durable manager-brain memory for a conversation. Best-effort. */
export async function getConversationAiMemory(
  conversationId: string,
): Promise<{ summary: string; turnsSeen: number }> {
  try {
    const row = await one<{ summary: string; turns_seen: number }>(
      `SELECT summary, turns_seen
         FROM conversation_ai_memory WHERE conversation_id = $1`,
      [conversationId],
    )
    if (!row) return { summary: '', turnsSeen: 0 }
    return { summary: row.summary ?? '', turnsSeen: Number(row.turns_seen) || 0 }
  } catch {
    return { summary: '', turnsSeen: 0 }
  }
}

/** Upsert durable manager-brain memory for a conversation. Best-effort. */
export async function saveConversationAiMemory(
  conversationId: string,
  summary: string,
  turnsSeen: number,
): Promise<void> {
  try {
    await query(
      `INSERT INTO conversation_ai_memory (conversation_id, summary, turns_seen, updated_at)
         VALUES ($1, $2, $3, now())
       ON CONFLICT (conversation_id)
         DO UPDATE SET summary = EXCLUDED.summary,
                       turns_seen = EXCLUDED.turns_seen,
                       updated_at = now()`,
      [conversationId, summary, turnsSeen],
    )
  } catch {
    /* memory is a non-critical enhancement */
  }
}

/** Recent turns of a conversation, oldest → newest, for the AI prompt. */
export async function getConversationHistoryForAi(
  conversationId: string,
  limit = 16,
): Promise<Array<{ role: 'client' | 'manager'; body: string }>> {
  // Include media-only turns (empty body) so the AI knows a sticker/photo/voice
  // message occurred instead of silently dropping it from the thread context.
  //
  // Enrollment cutoff (mirror of the panel): only feed the brain messages from
  // the moment the dialog was enrolled onward, so enrolling a pre-existing
  // thread never makes the AI replay old backlog or drift onto a stale topic.
  const rows = await query<{
  id: string
  direction: 'in' | 'out'
  body: string
  media_type: string | null
  media_understanding: string | null
  media_blob_id: string | null
  }>(
  `SELECT m.id, m.direction, m.body, m.media_type,
          m.media_understanding, m.media_blob_id
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN messages cut ON cut.id = c.ai_enrolled_from_message_id
  WHERE m.conversation_id = $1
  AND m.deleted_at IS NULL
  AND (m.body <> '' OR m.media_type IS NOT NULL)
  AND (cut.created_at IS NULL OR m.created_at >= cut.created_at)
  ORDER BY m.created_at DESC
  LIMIT $2`,
  [conversationId, Math.max(1, Math.min(50, limit))],
  )
  const ordered = rows.reverse()
  return Promise.all(
    ordered.map(async (r) => ({
      role: (r.direction === 'in' ? 'client' : 'manager') as
        | 'client'
        | 'manager',
      body: r.body.trim() || (await resolveMediaBodyForAi(r)),
    })),
  )
}

/**
 * Turn a media-only row into the richest text the brain can use: a cached
 * understanding if present, otherwise analyze the stored bytes once (vision for
 * images, speech-to-text for voice/audio), persist it, and use it. Falls back
 * to a placeholder when there are no bytes or analysis fails. (Worker runtime.)
 */
async function resolveMediaBodyForAi(row: {
  id: string
  media_type: string | null
  media_understanding: string | null
  media_blob_id: string | null
}): Promise<string> {
  if (row.media_understanding && row.media_understanding.trim()) {
    return row.media_understanding.trim()
  }
  if (row.media_blob_id) {
    try {
      const understood = await understandMedia({
        mediaType: row.media_type,
        loadBytes: () => getStoredMediaBytes(row.id),
      })
      if (understood) {
        await query(
          `UPDATE messages SET media_understanding = $2 WHERE id = $1`,
          [row.id, understood],
        )
        return understood
      }
    } catch {
      /* fall through to placeholder */
    }
  }
  return mediaPlaceholderForAi(row.media_type)
}

/** Short human-readable stand-in for a media-only message in AI history. */
function mediaPlaceholderForAi(type: string | null): string {
  switch (type) {
    case 'image':
      return '[фото]'
    case 'video':
    case 'video_note':
      return '[видео]'
    case 'audio':
      return '[аудио]'
    case 'voice':
      return '[голосовое сообщение]'
    case 'sticker':
      return '[стикер]'
    case 'document':
      return '[документ]'
    default:
      return '[вложение]'
  }
}
