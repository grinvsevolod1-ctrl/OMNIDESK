import 'server-only'
import { query } from '../db'
import { understandMedia } from '../ai/manager-brain'
import type { MediaType } from '../types'
import { mediaPlaceholder } from './ai-assist-shared'
import { getStoredMediaBytes } from './media-archive'

/**
 * Conversation history + durable per-conversation AI memory.
 * Split out of ai-assist.ts (which remains the barrel — import from there).
 */

/**
 * Recent turns of a conversation, oldest → newest, mapped to the AI history
 * shape (inbound = client, outbound = manager). Used by the live-chat AI-lead
 * runtime to give the brain conversational context.
 */
export async function getConversationHistoryForAi(
  conversationId: string,
  limit = 16,
): Promise<Array<{ role: 'client' | 'manager'; body: string }>> {
  // Include media-only turns (empty body) so the AI knows a sticker/photo/voice
  // message occurred instead of silently dropping it from the thread context.
  //
  // Enrollment cutoff: the AI must only ever see messages from the moment the
  // dialog was enrolled onward. This is THE fix for "AI joined an old dialog and
  // started talking about a different topic": when an admin enrolls a
  // pre-existing thread we stamp ai_enrolled_from_message_id, and the brain is
  // fed only the turns at/after that point — never the stale backlog above it.
  const rows = await query<{
    id: string
    direction: 'in' | 'out'
    body: string
    media_type: MediaType | null
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
        -- Enrollment cutoff, robust to a deleted cutoff message: prefer the
        -- stamped message's timestamp, but fall back to ai_enrolled_at when
        -- that message was later deleted (cut.created_at becomes NULL) so the
        -- AI never silently regains the whole stale backlog. Only fully
        -- fails open when the dialog was never enrolled from a message.
        AND (
          c.ai_enrolled_from_message_id IS NULL
          OR COALESCE(cut.created_at, c.ai_enrolled_at) IS NULL
          OR m.created_at >= COALESCE(cut.created_at, c.ai_enrolled_at)
        )
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
      body: r.body.trim() || (await resolveMediaBody(r)),
    })),
  )
}

/**
 * Turn a media-only row into the richest text the brain can use: a cached
 * understanding if we have one, otherwise analyze the stored bytes once
 * (vision for images, speech-to-text for voice/audio), persist the result, and
 * use it. Falls back to a plain placeholder when there are no bytes or analysis
 * fails — so a reply is never blocked by media handling. (Panel runtime.)
 */
async function resolveMediaBody(row: {
  id: string
  media_type: MediaType | null
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
  return mediaPlaceholder(row.media_type)
}

/** Read the durable manager-brain memory for a conversation ('' if none). */
export async function getConversationAiMemory(
  conversationId: string,
): Promise<{ summary: string; turnsSeen: number }> {
  try {
    const rows = await query<{ summary: string; turns_seen: number }>(
      `SELECT summary, turns_seen
         FROM conversation_ai_memory WHERE conversation_id = $1`,
      [conversationId],
    )
    if (rows.length === 0) return { summary: '', turnsSeen: 0 }
    return {
      summary: rows[0].summary ?? '',
      turnsSeen: Number(rows[0].turns_seen) || 0,
    }
  } catch {
    // Pre-migration or transient error — behave as "no memory yet".
    return { summary: '', turnsSeen: 0 }
  }
}

/** Upsert the durable manager-brain memory for a conversation. Best-effort. */
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
    /* memory is a non-critical enhancement — swallow */
  }
}
