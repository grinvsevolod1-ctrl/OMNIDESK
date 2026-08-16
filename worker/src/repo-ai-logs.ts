import { query } from './db.js'

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
