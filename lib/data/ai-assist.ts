import 'server-only'
import { query } from '../db'
import {
  type BrainLesson,
  embedText,
  toVectorLiteral,
} from '../ai/manager-brain'
import type { MediaType } from '../types'
import { mediaPlaceholder } from './ai-assist-shared'

/* --------------------------------------------------------------------------
 * Domain re-exports. Training-corpus and corrections/review concerns were split
 * into focused sibling modules; callers keep importing them from this module.
 * ------------------------------------------------------------------------ */
export { mediaPlaceholder } from './ai-assist-shared'
export type { TrainingSample } from './ai-assist-shared'
export * from './ai-assist-training'
export * from './ai-assist-corrections'

/** Shared (singleton) AI-assistant configuration + distilled playbook. */
export interface AiAssistSettings {
  enabled: boolean
  tone: string
  persona: string
  playbook: string[]
  /** Manager-brain model id (empty → code default 'openai/gpt-4.1'). */
  model: string
  /** Sampling temperature 0..2. */
  temperature: number
  /** Max completion tokens per reply. */
  maxTokens: number
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
  model: string | null
  temperature: number | string | null
  max_tokens: number | string | null
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
    model: r.model ?? '',
    temperature: r.temperature == null ? 0.7 : Number(r.temperature),
    maxTokens: r.max_tokens == null ? 400 : Number(r.max_tokens),
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
     RETURNING enabled, tone, persona, playbook, model, temperature, max_tokens, updated_at`,
  )
  return mapSettings(rows[0])
}

/** Update the shared config (tone / persona / master switch / model tuning). */
export async function updateAiAssistSettings(patch: {
  enabled?: boolean
  tone?: string
  persona?: string
  model?: string
  temperature?: number
  maxTokens?: number
}): Promise<AiAssistSettings> {
  const rows = await query<SettingsRow>(
    `UPDATE ai_assist_settings SET
        enabled     = COALESCE($1, enabled),
        tone        = COALESCE($2, tone),
        persona     = COALESCE($3, persona),
        model       = COALESCE($4, model),
        temperature = COALESCE($5, temperature),
        max_tokens  = COALESCE($6, max_tokens),
        updated_at = now()
      WHERE id = true
      RETURNING enabled, tone, persona, playbook, model, temperature, max_tokens, updated_at`,
    [
      patch.enabled ?? null,
      patch.tone ?? null,
      patch.persona ?? null,
      patch.model ?? null,
      patch.temperature ?? null,
      patch.maxTokens ?? null,
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

/** One manager-brain generation metric (durable A/B analytics). */
export interface AiGenerationMetricInput {
  model: string
  runtime: 'livechat' | 'worker' | 'trainer'
  purpose: 'reply' | 'assess'
  outcome: 'ok' | 'empty' | 'refused' | 'http_error' | 'exception'
  latencyMs?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  conversationId?: string | null
}

/**
 * Record one generation metric. Best-effort: never throws into the caller (a
 * metrics write must never break a reply), and tolerates the table being absent
 * pre-migration.
 */
export async function recordAiGenerationMetric(
  m: AiGenerationMetricInput,
): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_generation_metrics
         (model, runtime, purpose, outcome, latency_ms, prompt_tokens, completion_tokens, conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        m.model || '',
        m.runtime,
        m.purpose,
        m.outcome,
        m.latencyMs ?? null,
        m.promptTokens ?? null,
        m.completionTokens ?? null,
        m.conversationId ?? null,
      ],
    )
  } catch {
    /* metrics are non-critical — swallow (e.g. pre-migration) */
  }
}

/** Per-model aggregate stats over the last N days (drives the A/B panel). */
export interface AiModelStat {
  model: string
  total: number
  okRate: number
  avgLatencyMs: number
  avgCompletionTokens: number
}

export async function getAiModelStats(days = 7): Promise<AiModelStat[]> {
  const rows = await query<{
    model: string
    total: string
    ok: string
    avg_latency: string | null
    avg_tokens: string | null
  }>(
    `SELECT model,
            count(*)::text AS total,
            count(*) FILTER (WHERE outcome = 'ok')::text AS ok,
            avg(latency_ms) FILTER (WHERE outcome = 'ok') AS avg_latency,
            avg(completion_tokens) FILTER (WHERE outcome = 'ok') AS avg_tokens
       FROM ai_generation_metrics
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY model
      ORDER BY count(*) DESC`,
    [String(Math.max(1, Math.min(90, days)))],
  )
  return rows.map((r) => {
    const total = Number(r.total) || 0
    const ok = Number(r.ok) || 0
    return {
      model: r.model || '(default)',
      total,
      okRate: total > 0 ? ok / total : 0,
      avgLatencyMs: Math.round(Number(r.avg_latency ?? 0)),
      avgCompletionTokens: Math.round(Number(r.avg_tokens ?? 0)),
    }
  })
}

/* --------------------- Manager scoring (self-play) ---------------------- */

export interface ManagerScorecardRow {
  conversationId: string
  score: number
  outcome: string
  strengths: string[]
  weaknesses: string[]
  summary: string
  turns: number
  createdAt: string
}

/** Aggregate view for the scoring dashboard. */
export interface ManagerScoreSummary {
  avgScore: number
  count: number
  recent: ManagerScorecardRow[]
}

/**
 * Persist a manager scorecard (upsert by conversation). Best-effort: swallows
 * errors so scoring can never break the sim engine that calls it.
 */
export async function saveManagerScorecard(input: {
  conversationId: string
  score: number
  outcome: string
  strengths: string[]
  weaknesses: string[]
  summary: string
  turns: number
}): Promise<void> {
  try {
    await query(
      `INSERT INTO manager_scorecards
         (conversation_id, score, outcome, strengths, weaknesses, summary, turns, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         score = EXCLUDED.score, outcome = EXCLUDED.outcome,
         strengths = EXCLUDED.strengths, weaknesses = EXCLUDED.weaknesses,
         summary = EXCLUDED.summary, turns = EXCLUDED.turns, updated_at = now()`,
      [
        input.conversationId,
        Math.max(0, Math.min(100, Math.round(input.score))),
        input.outcome,
        input.strengths.join('\n'),
        input.weaknesses.join('\n'),
        input.summary,
        input.turns,
      ],
    )
  } catch (err) {
    console.error('saveManagerScorecard failed:', err)
  }
}

/** Recent scorecards + running average for the panel dashboard. */
export async function getManagerScoreSummary(
  limit = 20,
): Promise<ManagerScoreSummary> {
  try {
    const [agg] = await query<{ avg: string | null; cnt: string }>(
      `SELECT avg(score) AS avg, count(*)::text AS cnt
         FROM manager_scorecards
        WHERE created_at >= now() - interval '30 days'`,
    )
    const recent = await query<{
      conversation_id: string
      score: number
      outcome: string
      strengths: string
      weaknesses: string
      summary: string
      turns: number
      created_at: string | Date
    }>(
      `SELECT conversation_id, score, outcome, strengths, weaknesses,
              summary, turns, created_at
         FROM manager_scorecards
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(100, limit))],
    )
    return {
      avgScore: Math.round(Number(agg?.avg ?? 0)),
      count: Number(agg?.cnt ?? 0) || 0,
      recent: recent.map((r) => ({
        conversationId: r.conversation_id,
        score: Number(r.score) || 0,
        outcome: r.outcome ?? '',
        strengths: (r.strengths ?? '').split('\n').filter(Boolean),
        weaknesses: (r.weaknesses ?? '').split('\n').filter(Boolean),
        summary: r.summary ?? '',
        turns: Number(r.turns) || 0,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    }
  } catch {
    return { avgScore: 0, count: 0, recent: [] }
  }
}

/**
 * Add an auto-derived lesson from the self-play scoring loop. Deduplicates on
 * the situation text so the same weakness doesn't pile up identical lessons.
 * Best-effort. Tagged source='auto' so the panel can distinguish it.
 */
export async function addAutoLesson(input: {
  situation: string
  corrected: string
  note: string
}): Promise<void> {
  try {
    const existing = await query<{ id: string }>(
      `SELECT id FROM ai_assist_lessons
        WHERE source = 'auto' AND lower(situation) = lower($1)
        LIMIT 1`,
      [input.situation],
    )
    if (existing.length > 0) {
      await query(
        `UPDATE ai_assist_lessons
            SET corrected = $2, note = $3, created_at = now()
          WHERE id = $1`,
        [existing[0].id, input.corrected, input.note],
      )
      return
    }
    await query(
      `INSERT INTO ai_assist_lessons (situation, draft, corrected, note, source)
       VALUES ($1, '', $2, $3, 'auto')`,
      [input.situation, input.corrected, input.note],
    )
  } catch (err) {
    console.error('addAutoLesson failed:', err)
  }
}

/**
 * Most recent lessons for the ADMIN management UI (newest first). Auto-authored
 * lessons (source='auto') are deliberately excluded here: they are produced by
 * an internal, non-manager training path and must never surface in the normal
 * admin panel. They still power replies via `listBrainLessons`, which is
 * unfiltered — so learning happens invisibly, without exposing its origin.
 */
export async function listLessons(limit = 50): Promise<AiAssistLesson[]> {
  const rows = await query<LessonRow>(
    `SELECT id, situation, draft, corrected, note, created_at
       FROM ai_assist_lessons
      WHERE source IS DISTINCT FROM 'auto'
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
  //
  // Enrollment cutoff: the AI must only ever see messages from the moment the
  // dialog was enrolled onward. This is THE fix for "AI joined an old dialog and
  // started talking about a different topic": when an admin enrolls a
  // pre-existing thread we stamp ai_enrolled_from_message_id, and the brain is
  // fed only the turns at/after that point — never the stale backlog above it.
  const rows = await query<{
    direction: 'in' | 'out'
    body: string
    media_type: MediaType | null
  }>(
    `SELECT m.direction, m.body, m.media_type
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
 * True when the AI is effectively leading this conversation:
 *
 *   led = ai_assist_settings.enabled      -- master switch ON
 *         AND conversations.ai_enrolled    -- this dialog is AI-led
 *         AND NOT conversations.ai_paused   -- not temporarily paused
 *
 * IMPORTANT: simulated dialogs are intentionally NOT excluded here. To the AI
 * manager a simulator dialog must look exactly like a real client — same
 * participation rules, same brain, same replies. Simulated dialogs are also
 * treated as real everywhere else (inbox, status board, analytics, enrollment).
 * The is_simulated flag is used for only two things: (a) labeling a dialog as
 * simulated inside the secret panel, and (b) stopping the manager's reply from
 * being delivered to a real external channel (see the dispatch guards). New
 * dialogs are auto-enrolled at creation, so the AI leads them out of the box;
 * pre-existing dialogs stay manual until an admin enrolls them. A single CROSS
 * JOIN keeps this cheap.
 */
export async function isConversationAiLed(
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ led: boolean }>(
    `SELECT (s.enabled AND c.ai_enrolled AND NOT c.ai_paused) AS led
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
 * search over contact name. Simulated dialogs are treated as real and are
 * eligible like any other conversation.
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
 * from now on and never replays the old backlog / drifts off-topic. Works for
 * any dialog, simulated or not. Returns true when it enrolled.
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

/* --------------------------- RAG knowledge base ------------------------- */

export interface KnowledgeEntry {
  id: string
  title: string
  content: string
  enabled: boolean
  hasEmbedding: boolean
  updatedAt: string
}

interface KnowledgeRow {
  id: string
  title: string
  content: string
  enabled: boolean
  has_embedding: boolean
  updated_at: string | Date
}

function mapKnowledge(r: KnowledgeRow): KnowledgeEntry {
  return {
    id: r.id,
    title: r.title ?? '',
    content: r.content ?? '',
    enabled: !!r.enabled,
    hasEmbedding: !!r.has_embedding,
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/** List all knowledge entries (admin management view). */
export async function listKnowledge(): Promise<KnowledgeEntry[]> {
  const rows = await query<KnowledgeRow>(
    `SELECT id, title, content, enabled,
            (embedding IS NOT NULL) AS has_embedding, updated_at
       FROM ai_knowledge
      ORDER BY updated_at DESC`,
  )
  return rows.map(mapKnowledge)
}

/**
 * Create or replace a knowledge entry, computing its embedding up front. When
 * embedding fails the row is still stored (embedding NULL) so no content is
 * lost; it just won't be retrieved until re-embedded.
 */
export async function upsertKnowledge(input: {
  id?: string
  title: string
  content: string
  enabled?: boolean
}): Promise<KnowledgeEntry> {
  const embedding = await embedText(`${input.title}\n\n${input.content}`)
  const vecLiteral = embedding ? toVectorLiteral(embedding) : null

  if (input.id) {
    const rows = await query<KnowledgeRow>(
      `UPDATE ai_knowledge
          SET title = $2, content = $3,
              enabled = COALESCE($4, enabled),
              embedding = COALESCE($5::vector, embedding),
              updated_at = now()
        WHERE id = $1
        RETURNING id, title, content, enabled,
                  (embedding IS NOT NULL) AS has_embedding, updated_at`,
      [input.id, input.title, input.content, input.enabled ?? null, vecLiteral],
    )
    return mapKnowledge(rows[0])
  }

  const rows = await query<KnowledgeRow>(
    `INSERT INTO ai_knowledge (title, content, enabled, embedding)
       VALUES ($1, $2, COALESCE($3, true), $4::vector)
     RETURNING id, title, content, enabled,
               (embedding IS NOT NULL) AS has_embedding, updated_at`,
    [input.title, input.content, input.enabled ?? null, vecLiteral],
  )
  return mapKnowledge(rows[0])
}

/** Delete a knowledge entry. */
export async function deleteKnowledge(id: string): Promise<void> {
  await query(`DELETE FROM ai_knowledge WHERE id = $1`, [id])
}

/**
 * Retrieve the top-K knowledge chunks most relevant to `queryText`, assembled
 * into a compact block for injection into ManagerBrainInput.knowledge. Returns
 * '' when RAG is unavailable (no embedding, no matches, or pre-migration) so
 * the caller simply proceeds without retrieved facts. Best-effort — never
 * throws into the reply path.
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
    // Cosine distance < ~0.55 keeps only genuinely relevant chunks and avoids
    // stuffing the prompt with unrelated entries.
    const relevant = rows.filter((r) => Number(r.dist) < 0.55)
    if (relevant.length === 0) return ''
    return relevant
      .map((r) => (r.title ? `• ${r.title}: ${r.content}` : `• ${r.content}`))
      .join('\n')
  } catch {
    return ''
  }
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
  // Match listLessons: count only admin-visible lessons, never auto ones, so
  // the tab badge can't leak internal training volume.
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM ai_assist_lessons
      WHERE source IS DISTINCT FROM 'auto'`,
  )
  return Number(rows[0]?.n ?? 0)
}
