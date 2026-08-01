import { query, one } from './db.js'
import {
  embedText,
  toVectorLiteral,
  understandMedia,
} from '../../lib/ai/manager-brain.js'
import {
  applyExperimentBranch,
  assignExperimentBranch,
  parseOverrides,
  type OverridableSettings,
} from '../../lib/ai/experiment.js'
import { getStoredMediaBytes } from './repo-media.js'

/**
 * Worker-side AI/autopilot repository, extracted from repo.ts and re-exported
 * from it for backward compatibility. Covers autopilot rules & fire-dedup, the
 * AI-assist config/metrics/lessons/correction-rules, AI conversation memory,
 * knowledge retrieval, handoff bookkeeping and the AI transcript builder.
 */

/* ------------------------------ Autopilot ----------------------------- */

/** Raw autopilot rule row (worker view; matcher normalizes the config). */
export interface AutopilotRuleRow {
  id: string
  manager_id: string
  name: string
  enabled: boolean
  sort_order: number
  event: string
  config: unknown
}

/** Is the manager's autopilot master switch on? Defaults to OFF when no row. */
export async function autopilotEnabled(managerId: string): Promise<boolean> {
  const row = await one<{ enabled: boolean }>(
    `SELECT enabled FROM autopilot_settings WHERE manager_id = $1`,
    [managerId],
  )
  return !!row?.enabled
}

/** Active rules for a manager, priority order (sort_order asc, then created). */
export async function listEnabledAutopilotRules(
  managerId: string,
): Promise<AutopilotRuleRow[]> {
  return query<AutopilotRuleRow>(
    `SELECT id, manager_id, name, enabled, sort_order, event, config
       FROM autopilot_rules
      WHERE manager_id = $1 AND enabled = true
      ORDER BY sort_order ASC, created_at ASC`,
    [managerId],
  )
}

/**
 * Atomically claim the first fire of a rule on a conversation. Returns true if
 * THIS call recorded it (rule had not fired before), false if already fired.
 * Mirrors the panel-side tryRecordFire so dedupe is consistent across runtimes.
 */
export async function tryRecordAutopilotFire(
  ruleId: string,
  conversationId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `INSERT INTO autopilot_fires (rule_id, conversation_id)
     VALUES ($1, $2)
     ON CONFLICT (rule_id, conversation_id) DO NOTHING
     RETURNING id`,
    [ruleId, conversationId],
  )
  return rows.length > 0
}

/** Remove a fire record (used to roll back a claim when the send fails). */
export async function clearAutopilotFire(
  ruleId: string,
  conversationId: string,
): Promise<void> {
  await query(
    `DELETE FROM autopilot_fires WHERE rule_id = $1 AND conversation_id = $2`,
    [ruleId, conversationId],
  )
}

/* ------------------------- AI manager-assistant ------------------------- */

/** Shared AI-assistant config (singleton row) + distilled playbook. */
export interface AiAssistConfig {
  enabled: boolean
  tone: string
  persona: string
  playbook: string[]
  /** Manager-brain model id (empty → brain's built-in default). */
  model: string
  temperature: number
  maxTokens: number
  /** Persuasion intensity 0..3 (default 2 = assertive). */
  aggressiveness: number
  /**
   * The chat-driven mandate — admin's plain-language rules from ai_directives,
   * ordered and obeyed verbatim. Empty when none set or table absent.
   */
  directives: string[]
}

/**
 * Active directives (the chat-driven mandate) as ordered plain strings.
 * Best-effort: returns [] if the table is missing (pre-085 migration) so a
 * Telegram reply is never blocked.
 */
export async function getDirectiveTexts(): Promise<string[]> {
  try {
    const rows = await query<{ body: string }>(
      `SELECT body FROM ai_directives
        WHERE enabled = true
        ORDER BY sort_order ASC, created_at ASC`,
    )
    return rows.map((r) => (r.body ?? '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** One correction lesson in the shape the pure brain expects. */
export interface AiAssistLessonLite {
  situation: string
  corrected: string
  note: string
}

/** Read the singleton AI-assist settings. Missing row → disabled defaults. */
export async function getAiAssistConfig(): Promise<AiAssistConfig> {
  // Tolerate the model-config columns being absent (pre-069 migration): select
  // them defensively so an older DB still yields a valid config.
  const row = await one<{
    enabled: boolean
    tone: string
    persona: string
    playbook: unknown
    model: string | null
    temperature: number | string | null
    max_tokens: number | string | null
    aggressiveness: number | string | null
  }>(
    `SELECT enabled, tone, persona, playbook,
            COALESCE(model, '')      AS model,
            COALESCE(temperature, 0.7) AS temperature,
            COALESCE(max_tokens, 400)  AS max_tokens,
            COALESCE(aggressiveness, 2) AS aggressiveness
       FROM ai_assist_settings WHERE id = true`,
  ).catch(async () =>
    // Fallback for pre-migration schema without the new columns.
    one<{
      enabled: boolean
      tone: string
      persona: string
      playbook: unknown
      model: null
      temperature: null
      max_tokens: null
      aggressiveness: null
    }>(
      `SELECT enabled, tone, persona, playbook,
              NULL AS model, NULL AS temperature, NULL AS max_tokens,
              NULL AS aggressiveness
         FROM ai_assist_settings WHERE id = true`,
    ),
  )
  const directives = await getDirectiveTexts()
  return {
    enabled: !!row?.enabled,
    tone: row?.tone ?? 'professional',
    persona: row?.persona ?? '',
    playbook: Array.isArray(row?.playbook) ? (row!.playbook as string[]) : [],
    model: row?.model ?? '',
    temperature: row?.temperature == null ? 0.7 : Number(row!.temperature),
    maxTokens: row?.max_tokens == null ? 400 : Number(row!.max_tokens),
    aggressiveness:
      row?.aggressiveness == null
        ? 2
        : Math.max(0, Math.min(3, Math.round(Number(row!.aggressiveness)))),
    directives,
  }
}

/**
 * Overlay the active A/B experiment (if any) onto a settings snapshot for one
 * conversation, recording the branch assignment. Mirrors the panel-side
 * lib/data/ai-experiments.ts#applyActiveExperiment — same deterministic hash
 * (shared pure core), same fail-open contract: any error, including a pre-088
 * schema, returns the settings untouched so messenger replies never break.
 */
export async function applyActiveExperiment<T extends OverridableSettings>(
  settings: T,
  conversationId: string,
): Promise<{ settings: T; extraDirectives: string[] }> {
  try {
    const row = await one<{ id: string; name: string; overrides: unknown }>(
      `SELECT id, name, overrides FROM ai_experiments
        WHERE status = 'active' LIMIT 1`,
    )
    if (!row) return { settings, extraDirectives: [] }
    const branch = assignExperimentBranch(row.id, conversationId)
    void query(
      `INSERT INTO ai_experiment_assignments (experiment_id, conversation_id, branch)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [row.id, conversationId, branch],
    ).catch(() => {})
    return applyExperimentBranch(
      settings,
      { id: row.id, name: row.name, overrides: parseOverrides(row.overrides) },
      branch,
    )
  } catch {
    return { settings, extraDirectives: [] }
  }
}

/**
 * Record one manager-brain generation metric (durable A/B analytics). Mirrors
 * lib/data/ai-assist.ts#recordAiGenerationMetric so worker + panel write the
 * same table. Best-effort: swallows errors (incl. pre-migration absence).
 */
export async function recordAiGenerationMetric(m: {
  model: string
  purpose: 'reply' | 'assess'
  outcome: 'ok' | 'empty' | 'refused' | 'http_error' | 'exception'
  latencyMs?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  conversationId?: string | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_generation_metrics
         (model, runtime, purpose, outcome, latency_ms, prompt_tokens, completion_tokens, conversation_id)
       VALUES ($1, 'worker', $2, $3, $4, $5, $6, $7)`,
      [
        m.model || '',
        m.purpose,
        m.outcome,
        m.latencyMs ?? null,
        m.promptTokens ?? null,
        m.completionTokens ?? null,
        m.conversationId ?? null,
      ],
    )
  } catch {
    /* metrics are non-critical */
  }
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
 */
export async function isConversationAiLed(
  conversationId: string,
): Promise<boolean> {
  const row = await one<{ led: boolean }>(
    `SELECT (s.enabled AND c.ai_enrolled AND NOT c.ai_paused) AS led
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

// ── ai_logs micro-batched write path (mirror of lib/data/ai-log.ts) ──────────
// Entries are buffered in-process and flushed as ONE multi-row INSERT so a
// burst of log calls costs a single round-trip and the ingestion/reply path
// never waits on a diagnostics write. Trim is a cheap PK-range watermark
// delete instead of the old OFFSET subquery; the table itself is UNLOGGED
// with aggressive autovacuum since migration 089.

const AI_LOG_FLUSH_AT = 20
const AI_LOG_FLUSH_AFTER_MS = 250
const AI_LOG_BUFFER_CAP = 500
const AI_LOG_TRIM_EVERY_FLUSHES = 25
/** Watermark distance: 2× the 1500-row cap, since bigserial ids may have gaps. */
const AI_LOG_TRIM_KEEP_IDS = 3000

type AiLogPendingRow = [
  string,
  string,
  string,
  string,
  string | null,
  string | null,
  string | null,
]

const aiLogBuffer: AiLogPendingRow[] = []
let aiLogFlushTimer: NodeJS.Timeout | null = null
let aiLogFlushing = false
let aiLogFlushCount = 0

async function flushAiLogs(): Promise<void> {
  if (aiLogFlushing) return
  aiLogFlushing = true
  try {
    while (aiLogBuffer.length > 0) {
      const batch = aiLogBuffer.splice(0, AI_LOG_FLUSH_AT * 5)
      await query(
        `INSERT INTO ai_logs
           (level, source, event, message, conversation_id, channel_type, meta)
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[],
           $5::uuid[], $6::text[], $7::jsonb[]
         )`,
        [0, 1, 2, 3, 4, 5, 6].map((col) => batch.map((row) => row[col])),
      )
      aiLogFlushCount++
      if (aiLogFlushCount % AI_LOG_TRIM_EVERY_FLUSHES === 0) {
        await query(
          `DELETE FROM ai_logs
            WHERE id < (SELECT COALESCE(max(id), 0) FROM ai_logs) - $1`,
          [AI_LOG_TRIM_KEEP_IDS],
        )
      }
    }
  } catch {
    // Diagnostics must never break the observed path.
  } finally {
    aiLogFlushing = false
  }
}

function scheduleAiLogFlush(): void {
  if (aiLogBuffer.length >= AI_LOG_FLUSH_AT) {
    if (aiLogFlushTimer) {
      clearTimeout(aiLogFlushTimer)
      aiLogFlushTimer = null
    }
    void flushAiLogs()
    return
  }
  if (aiLogFlushTimer) return
  aiLogFlushTimer = setTimeout(() => {
    aiLogFlushTimer = null
    void flushAiLogs()
  }, AI_LOG_FLUSH_AFTER_MS)
  // Never keep the worker alive just to write diagnostics.
  aiLogFlushTimer.unref?.()
}

/**
 * Append one AI activity-log entry to the SHARED `ai_logs` table (migration
 * 058), so messenger/worker AI events show up in the panel "Логи" tab alongside
 * live-chat + simulator activity. Best-effort: never throws (a missing table or
 * DB hiccup must not break message ingestion). Resolves immediately — the row
 * is buffered and written in a micro-batch off the caller's path.
 */
export async function logAi(input: {
  level?: 'debug' | 'info' | 'warn' | 'error'
  source?: string
  event: string
  message?: string
  conversationId?: string | null
  channelType?: string | null
  meta?: Record<string, unknown> | null
}): Promise<void> {
  try {
    aiLogBuffer.push([
      input.level ?? 'info',
      input.source ?? 'worker',
      input.event,
      (input.message ?? '').slice(0, 4000),
      input.conversationId ?? null,
      input.channelType ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
    ])
    if (aiLogBuffer.length > AI_LOG_BUFFER_CAP) {
      aiLogBuffer.splice(0, aiLogBuffer.length - AI_LOG_BUFFER_CAP)
    }
    scheduleAiLogFlush()
  } catch {
    // Diagnostics must never break the observed path.
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

/**
 * Count autopilot sends on a channel within a trailing window (minutes). Used
 * to enforce per-channel anti-ban rate caps for messengers.
 */
export async function countAutopilotSends(
  channelId: string,
  withinMinutes: number,
): Promise<number> {
  const row = await one<{ n: string }>(
    `SELECT COUNT(*)::int AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE c.channel_id = $1
        AND m.direction = 'out'
        AND m.is_autopilot = true
        AND m.created_at > now() - ($2 || ' minutes')::interval`,
    [channelId, String(withinMinutes)],
  )
  return Number(row?.n ?? 0)
}

/**
 * Conversations with an inbound that hasn't been answered for >= N minutes and
 * where the manager's autopilot is on. Drives the 'no_response' scheduler.
 * Only returns the data the matcher/sender needs; dedupe is checked per rule.
 */
export async function findNoResponseConversations(maxMinutes: number): Promise<
  Array<{
    conversationId: string
    channelId: string
    managerId: string
    channelType: 'telegram' | 'whatsapp' | 'livechat'
    contactHandle: string
    lastInboundText: string
    minutesSilent: number
  }>
> {
  const rows = await query<{
    conversation_id: string
    channel_id: string
    manager_id: string
    channel_type: 'telegram' | 'whatsapp' | 'livechat'
    contact_handle: string
    last_inbound_text: string
    minutes_silent: number
  }>(
    `WITH last_in AS (
       SELECT DISTINCT ON (m.conversation_id)
              m.conversation_id, m.body, m.created_at
         FROM messages m
        WHERE m.direction = 'in'
        ORDER BY m.conversation_id, m.created_at DESC
     ),
     last_out AS (
       SELECT m.conversation_id, MAX(m.created_at) AS created_at
         FROM messages m
        WHERE m.direction = 'out'
        GROUP BY m.conversation_id
     )
     SELECT c.id AS conversation_id, c.channel_id, c.manager_id,
            c.channel_type, c.contact_handle,
            li.body AS last_inbound_text,
            EXTRACT(EPOCH FROM (now() - li.created_at)) / 60 AS minutes_silent
       FROM conversations c
       JOIN last_in li ON li.conversation_id = c.id
       JOIN autopilot_settings s ON s.manager_id = c.manager_id AND s.enabled = true
       LEFT JOIN last_out lo ON lo.conversation_id = c.id
      WHERE (lo.created_at IS NULL OR lo.created_at < li.created_at)
        AND li.created_at < now() - '1 minute'::interval
        AND li.created_at > now() - ($1 || ' minutes')::interval`,
    [String(maxMinutes)],
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    channelId: r.channel_id,
    managerId: r.manager_id,
    channelType: r.channel_type,
    contactHandle: r.contact_handle,
    lastInboundText: r.last_inbound_text,
    minutesSilent: Number(r.minutes_silent),
  }))
}

/** Working-hours JSON for a channel (any type), for the matcher's WH condition. */
export async function getChannelWorkingHours(
  channelId: string,
): Promise<unknown | null> {
  const row = await one<{ config: { widget?: { workingHours?: unknown } } | null }>(
    `SELECT config FROM channels WHERE id = $1`,
    [channelId],
  )
  return row?.config?.widget?.workingHours ?? null
}
