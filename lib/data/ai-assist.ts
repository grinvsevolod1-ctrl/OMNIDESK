import 'server-only'
import { query } from '../db'
import type { BrainLesson } from '../ai/manager-brain'
import type { MediaType } from '../types'

/** Short human-readable stand-in for a media-only message in AI history. */
function mediaPlaceholder(type: MediaType | null): string {
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

/** Shared (singleton) AI-assistant configuration + distilled playbook. */
export interface AiAssistSettings {
  enabled: boolean
  tone: string
  persona: string
  playbook: string[]
  updatedAt: string
}

export interface AiAssistLesson {
  id: string
  situation: string
  draft: string
  corrected: string
  note: string
  createdAt: string
}

interface SettingsRow {
  enabled: boolean
  tone: string
  persona: string
  playbook: string[] | null
  updated_at: string | Date
}

interface LessonRow {
  id: string
  situation: string
  draft: string
  corrected: string
  note: string
  created_at: string | Date
}

function mapSettings(r: SettingsRow): AiAssistSettings {
  return {
    enabled: r.enabled,
    tone: r.tone ?? 'professional',
    persona: r.persona ?? '',
    playbook: Array.isArray(r.playbook) ? r.playbook : [],
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

function mapLesson(r: LessonRow): AiAssistLesson {
  return {
    id: r.id,
    situation: r.situation ?? '',
    draft: r.draft ?? '',
    corrected: r.corrected ?? '',
    note: r.note ?? '',
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/** Read the singleton settings row, creating it lazily if missing. */
export async function getAiAssistSettings(): Promise<AiAssistSettings> {
  const rows = await query<SettingsRow>(
    `INSERT INTO ai_assist_settings (id) VALUES (true)
       ON CONFLICT (id) DO UPDATE SET id = true
     RETURNING enabled, tone, persona, playbook, updated_at`,
  )
  return mapSettings(rows[0])
}

/** Update the shared config (tone / persona / master switch). */
export async function updateAiAssistSettings(patch: {
  enabled?: boolean
  tone?: string
  persona?: string
}): Promise<AiAssistSettings> {
  const rows = await query<SettingsRow>(
    `UPDATE ai_assist_settings SET
        enabled = COALESCE($1, enabled),
        tone    = COALESCE($2, tone),
        persona = COALESCE($3, persona),
        updated_at = now()
      WHERE id = true
      RETURNING enabled, tone, persona, playbook, updated_at`,
    [
      patch.enabled ?? null,
      patch.tone ?? null,
      patch.persona ?? null,
    ],
  )
  if (rows.length === 0) {
    // Row didn't exist yet — create then retry once.
    await getAiAssistSettings()
    return updateAiAssistSettings(patch)
  }
  return mapSettings(rows[0])
}

/** Overwrite the distilled playbook (called after training). */
export async function savePlaybook(playbook: string[]): Promise<void> {
  await query(
    `UPDATE ai_assist_settings
        SET playbook = $1::jsonb, updated_at = now()
      WHERE id = true`,
    [JSON.stringify(playbook)],
  )
}

/** Most recent lessons (newest first). */
export async function listLessons(limit = 50): Promise<AiAssistLesson[]> {
  const rows = await query<LessonRow>(
    `SELECT id, situation, draft, corrected, note, created_at
       FROM ai_assist_lessons
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(200, limit))],
  )
  return rows.map(mapLesson)
}

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
  const rows = await query<{
    direction: 'in' | 'out'
    body: string
    media_type: MediaType | null
  }>(
    `SELECT direction, body, media_type FROM messages
      WHERE conversation_id = $1
        AND deleted_at IS NULL
        AND (body <> '' OR media_type IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, Math.max(1, Math.min(50, limit))],
  )
  return rows
    .reverse()
    .map((r) => ({
      role: (r.direction === 'in' ? 'client' : 'manager') as
        | 'client'
        | 'manager',
      body: r.body.trim() || mediaPlaceholder(r.media_type),
    }))
}

/**
 * True when the AI is effectively leading this conversation. Global-lead mode
 * (migration 056): the AI leads EVERY conversation when the master switch is
 * on, unless the conversation has been manually paused (opt-out). So:
 *
 *   led = ai_assist_settings.enabled AND NOT conversations.ai_paused
 *
 * A single round-trip via CROSS JOIN keeps this cheap for the schedulers.
 */
export async function isConversationAiLed(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ led: boolean }>(
    `SELECT (s.enabled AND NOT c.ai_paused) AS led
       FROM conversations c
       CROSS JOIN ai_assist_settings s
      WHERE c.id = $1 AND s.id = true`,
    [conversationId],
  )
  return Boolean(rows[0]?.led)
}

/**
 * Manager pauses/resumes the AI for a single conversation (the per-conversation
 * opt-out of global-lead mode). Manager-scoped so a manager can only toggle
 * their own threads. Returns the new paused state, or null when not owned.
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

/**
 * The AI decided this lead is ready («Ликвид») and hands it to a human. Called
 * by the AI runtimes (worker + live-chat) — UNSCOPED, no manager session. Only
 * promotes when the lead still has its default/empty status, so a manual
 * «Не ликвид»/«Передан» override is never clobbered. Also pauses the AI so the
 * human takes over cleanly, and flags a pending handoff for the inbox banner.
 * Returns true when it actually promoted (so the caller can log it once).
 */
export async function markAiHandoffToLiquid(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET status = 'liquid',
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
 * "Take over everything" operation. Flips the whole system so the AI leads
 * EVERY conversation except the ones already «Передан» (transferred — a human
 * has qualified & passed them on, so we must not touch those):
 *   1. turns the master switch ON,
 *   2. resets every non-transferred conversation to «Отписка» (unsubscribed),
 *   3. un-pauses the AI on them and clears any pending handoff flag so the AI
 *      resumes control instead of waiting on a human.
 * Returns how many conversations were affected. Idempotent — safe to re-run.
 */
export async function engageAiEverywhere(): Promise<{ affected: number }> {
  await query(`UPDATE ai_assist_settings SET enabled = true WHERE id = true`)
  const rows = await query<{ id: string }>(
    `UPDATE conversations
        SET status = 'unsubscribed',
            status_detail = NULL,
            status_updated_at = now(),
            ai_paused = false,
            ai_handoff_pending = false
      WHERE COALESCE(status, 'unsubscribed') <> 'transferred'
      RETURNING id`,
  )
  return { affected: rows.length }
}

/** A conversation waiting on the AI, with everything needed to kickstart it. */
export interface AwaitingConversation {
  conversationId: string
  managerId: string
  channelId: string
  text: string
}

/**
 * Conversations where the AI should speak next: not «Передан», AI not paused,
 * and the LATEST message is inbound (the client wrote and nobody answered).
 * Ordered oldest-waiting-first so the longest-ignored people get answered
 * first. Used by the "engage everywhere" kickstart to catch up the backlog of
 * old, never-answered dialogues (the normal trigger only fires on brand-new
 * inbound, so pre-existing hanging threads need this explicit sweep).
 */
export async function listConversationsAwaitingAi(
  limit: number,
): Promise<AwaitingConversation[]> {
  const rows = await query<{
    conversation_id: string
    manager_id: string
    channel_id: string
    body: string
  }>(
    `SELECT c.id AS conversation_id, c.manager_id, c.channel_id, m.body
       FROM conversations c
       JOIN LATERAL (
         SELECT direction, body, created_at
           FROM messages
          WHERE conversation_id = c.id AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
       ) m ON true
      WHERE COALESCE(c.status, 'unsubscribed') <> 'transferred'
        AND c.ai_paused = false
        AND m.direction = 'in'
      ORDER BY m.created_at ASC
      LIMIT $1`,
    [Math.max(1, Math.min(100, limit))],
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    managerId: r.manager_id,
    channelId: r.channel_id,
    text: r.body,
  }))
}

/** Count of conversations still waiting on an AI reply (drives progress UI). */
export async function countConversationsAwaitingAi(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM conversations c
       JOIN LATERAL (
         SELECT direction FROM messages
          WHERE conversation_id = c.id AND deleted_at IS NULL
          ORDER BY created_at DESC LIMIT 1
       ) m ON true
      WHERE COALESCE(c.status, 'unsubscribed') <> 'transferred'
        AND c.ai_paused = false
        AND m.direction = 'in'`,
  )
  return Number(rows[0]?.n ?? 0)
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

/** Lessons in the shape the pure brain expects (for prompt injection). */
export async function listBrainLessons(limit = 12): Promise<BrainLesson[]> {
  const rows = await query<LessonRow>(
    `SELECT situation, corrected, note
       FROM ai_assist_lessons
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(50, limit))],
  )
  return rows.map((r) => ({
    situation: r.situation ?? '',
    corrected: r.corrected ?? '',
    note: r.note ?? '',
  }))
}

/** Persist one training correction. */
export async function addLesson(input: {
  situation: string
  draft: string
  corrected: string
  note: string
}): Promise<AiAssistLesson> {
  const rows = await query<LessonRow>(
    `INSERT INTO ai_assist_lessons (situation, draft, corrected, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id, situation, draft, corrected, note, created_at`,
    [input.situation, input.draft, input.corrected, input.note],
  )
  return mapLesson(rows[0])
}

export async function deleteLesson(id: string): Promise<void> {
  await query(`DELETE FROM ai_assist_lessons WHERE id = $1`, [id])
}

export async function countLessons(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_assist_lessons`,
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * A recent conversation the admin can practise on in the trainer: the last
 * inbound client line plus the preceding turns for context. Samples across all
 * managers (the knowledge base is shared) and returns the newest few.
 */
export interface TrainingSample {
  conversationId: string
  lastClientMessage: string
  history: Array<{ role: 'client' | 'manager'; body: string }>
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
