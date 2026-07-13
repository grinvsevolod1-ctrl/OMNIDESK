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

/** True when the AI is set to lead this specific conversation. */
export async function isConversationAiLed(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ ai_autopilot_enabled: boolean }>(
    `SELECT ai_autopilot_enabled FROM conversations WHERE id = $1`,
    [conversationId],
  )
  return Boolean(rows[0]?.ai_autopilot_enabled)
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
