import 'server-only'
import { query } from '../db'
import { fetchMessageSlicesBatch } from './shared'

/**
 * AI-assist training-corpus data layer, extracted from the ai-assist monolith
 * and re-exported from it for backward compatibility. Lists trainable accounts,
 * counts/collects two-way dialogs and builds/samples the training corpus.
 */

/** A messaging account the admin can train the AI on, with its dialog volume. */
export interface TrainableAccount {
  channelId: string
  label: string
  channelType: string
  dialogCount: number
}

/**
 * Messaging accounts (Telegram/WhatsApp/VK/MAX) with how many of their dialogs
 * have real two-way history (both a client and a manager message) — i.e. how
 * much material is available to learn that account's style from. Ordered by the
 * richest accounts first. Live-chat is excluded (managed on its own page).
 */
export async function listTrainableAccounts(): Promise<TrainableAccount[]> {
  const rows = await query<{
    channel_id: string
    name: string | null
    detail: string | null
    channel_type: string
    dialog_count: string
  }>(
    `SELECT c.id AS channel_id,
            c.name AS name,
            c.detail AS detail,
            c.type AS channel_type,
            COUNT(DISTINCT conv.id)::text AS dialog_count
       FROM channels c
       JOIN conversations conv ON conv.channel_id = c.id
       JOIN messages m ON m.conversation_id = conv.id
                       AND m.deleted_at IS NULL AND m.body <> ''
      WHERE c.type IN ('telegram', 'whatsapp', 'vk', 'max')
      GROUP BY c.id, c.name, c.detail, c.type
      HAVING COUNT(*) FILTER (WHERE m.direction = 'in')  > 0
         AND COUNT(*) FILTER (WHERE m.direction = 'out') > 0
      ORDER BY COUNT(DISTINCT conv.id) DESC`,
  )
  return rows.map((r) => {
    const base = r.name?.trim() || r.channel_type
    const label = r.detail?.trim() ? `${base} (${r.detail.trim()})` : base
    return {
      channelId: r.channel_id,
      label,
      channelType: r.channel_type,
      dialogCount: Number(r.dialog_count ?? 0),
    }
  })
}

/** Result of harvesting one account's dialogs for training. */
export interface AccountTrainingCorpus {
  /** Human-readable transcripts (oldest→newest) for playbook distillation. */
  transcripts: string[]
  /** Client-line → manager-reply pairs to store as few-shot style lessons. */
  exchanges: Array<{ situation: string; corrected: string }>
}

/**
 * Every two-way conversation id of an account (both a client and a manager
 * message present), newest-first. No cap — this is the basis for FULL training
 * on the entire account history; the caller batches through the ids.
 */
export async function listAccountTwoWayConversationIds(
  channelId: string,
): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT conv.id
       FROM conversations conv
       JOIN messages m ON m.conversation_id = conv.id
                       AND m.deleted_at IS NULL AND m.body <> ''
      WHERE conv.channel_id = $1
      GROUP BY conv.id, conv.last_message_at
     HAVING COUNT(*) FILTER (WHERE m.direction = 'in')  > 0
        AND COUNT(*) FILTER (WHERE m.direction = 'out') > 0
      ORDER BY conv.last_message_at DESC`,
    [channelId],
  )
  return rows.map((r) => r.id)
}

/** How many two-way dialogs an account has (drives the training progress UI). */
export async function countAccountTwoWayDialogs(
  channelId: string,
): Promise<number> {
  const ids = await listAccountTwoWayConversationIds(channelId)
  return ids.length
}

/**
 * Build the training corpus for a specific batch of conversation ids: full
 * transcripts (for playbook distillation) + client→manager exchange pairs (as
 * few-shot "good answer" lessons). Shared by both the capped sampler and the
 * full-history trainer so they harvest identically.
 */
export async function buildTrainingCorpusForConversationIds(
  conversationIds: string[],
): Promise<AccountTrainingCorpus> {
  const transcripts: string[] = []
  const exchanges: Array<{ situation: string; corrected: string }> = []

  // Batched window query instead of one query per conversation (N+1). Chunked
  // so the full-history trainer (hundreds of ids) keeps each result set sane:
  // 50 ids x 60 messages = at most 3 000 rows per round-trip.
  const CHUNK = 50
  const slices = new Map<
    string,
    Array<{ direction: 'in' | 'out'; body: string }>
  >()
  for (let i = 0; i < conversationIds.length; i += CHUNK) {
    const part = await fetchMessageSlicesBatch(
      conversationIds.slice(i, i + CHUNK),
      { perConversation: 60, order: 'asc' },
    )
    for (const [id, rows] of part) slices.set(id, rows)
  }

  for (const id of conversationIds) {
    const rows = slices.get(id) ?? []
    if (rows.length < 2) continue

    const lines = rows.map(
      (r) => `${r.direction === 'in' ? 'Клиент' : 'Менеджер'}: ${r.body.trim()}`,
    )
    transcripts.push(lines.join('\n'))

    // Pull client→manager adjacent pairs as style examples (cap a few per
    // dialog so one chatty thread can't dominate the lesson set).
    let perDialog = 0
    for (let i = 0; i < rows.length - 1 && perDialog < 3; i++) {
      if (rows[i].direction === 'in' && rows[i + 1].direction === 'out') {
        const situation = rows[i].body.trim()
        const corrected = rows[i + 1].body.trim()
        if (situation && corrected && corrected.length <= 600) {
          exchanges.push({ situation, corrected })
          perDialog++
        }
      }
    }
  }

  return { transcripts, exchanges }
}

/**
 * Harvest an account's richest two-way dialogs (capped) into transcripts +
 * exchange pairs. Kept for callers that only want a quick sample; full training
 * uses {@link listAccountTwoWayConversationIds} + batched corpus building.
 */
export async function sampleAccountDialogsForTraining(
  channelId: string,
  maxDialogs = 40,
): Promise<AccountTrainingCorpus> {
  const ids = (await listAccountTwoWayConversationIds(channelId)).slice(
    0,
    Math.max(1, maxDialogs),
  )
  return buildTrainingCorpusForConversationIds(ids)
}

/**
 * Idempotent style-lesson insert used by account training: skips the write when
 * an identical (situation, corrected) lesson already exists, so re-training the
 * same account doesn't endlessly duplicate the corpus. Returns true if inserted.
 */
export async function addLessonIfNew(input: {
  situation: string
  corrected: string
  note: string
}): Promise<boolean> {
  const dupe = await query<{ id: string }>(
    `SELECT id FROM ai_assist_lessons
      WHERE situation = $1 AND corrected = $2
      LIMIT 1`,
    [input.situation, input.corrected],
  )
  if (dupe.length > 0) return false
  await query(
    `INSERT INTO ai_assist_lessons (situation, draft, corrected, note)
     VALUES ($1, '', $2, $3)`,
    [input.situation, input.corrected, input.note],
  )
  return true
}

