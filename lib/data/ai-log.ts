import 'server-only'
import { query } from '../db'

/**
 * AI activity log — the panel-side writer/reader for the `ai_logs` table (see
 * migration 058). This is the diagnostics stream behind the "Логи" tab: it
 * records WHY the assistant acted (or stayed silent), the replies it produced,
 * gateway failures, lead promotions and errors — the things that were
 * previously only console.log'd and lost.
 *
 * Design rules:
 *  - Writes are BEST-EFFORT and NEVER throw. Logging must not be able to break
 *    the thing it is observing (a reply send, a sim tick, ingestion).
 *  - The table is a capped ring buffer; we trim old rows opportunistically so
 *    it can't grow without bound.
 */

export type AiLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AiLogInput {
  level?: AiLogLevel
  source?: string
  event: string
  message?: string
  conversationId?: string | null
  channelType?: string | null
  meta?: Record<string, unknown> | null
}

export interface AiLogRow {
  id: string
  createdAt: string
  level: AiLogLevel
  source: string
  event: string
  message: string
  conversationId: string | null
  channelType: string | null
  meta: Record<string, unknown> | null
}

/** Keep at most this many rows; older ones are trimmed opportunistically. */
const MAX_ROWS = 1500

interface DbRow {
  id: string
  created_at: string | Date
  level: string
  source: string
  event: string
  message: string
  conversation_id: string | null
  channel_type: string | null
  meta: Record<string, unknown> | null
}

function mapRow(r: DbRow): AiLogRow {
  return {
    id: String(r.id),
    createdAt: new Date(r.created_at).toISOString(),
    level: (['debug', 'info', 'warn', 'error'].includes(r.level)
      ? r.level
      : 'info') as AiLogLevel,
    source: r.source ?? 'ai',
    event: r.event ?? '',
    message: r.message ?? '',
    conversationId: r.conversation_id,
    channelType: r.channel_type,
    meta: r.meta ?? null,
  }
}

/**
 * Append one entry. Fire-and-forget friendly: callers may `void logAi(...)`.
 * Swallows every error (including a not-yet-migrated table) so it is always
 * safe to call from hot paths.
 */
export async function logAi(input: AiLogInput): Promise<void> {
  try {
    const message = (input.message ?? '').slice(0, 4000)
    await query(
      `INSERT INTO ai_logs
         (level, source, event, message, conversation_id, channel_type, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        input.level ?? 'info',
        input.source ?? 'ai',
        input.event,
        message,
        input.conversationId ?? null,
        input.channelType ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
      ],
    )
    // Opportunistic trim (~4% of writes) so the ring buffer stays bounded
    // without paying the cost on every insert.
    if (Math.random() < 0.04) {
      await query(
        `DELETE FROM ai_logs
          WHERE id <= (
            SELECT id FROM ai_logs ORDER BY id DESC OFFSET $1 LIMIT 1
          )`,
        [MAX_ROWS],
      )
    }
  } catch {
    // Diagnostics must never break the observed path.
  }
}

/**
 * Tail the log newest-first. `sinceId` returns only rows newer than a cursor
 * (for incremental polling); `level` filters to a minimum severity when given.
 */
export async function listAiLogs(opts?: {
  limit?: number
  sinceId?: string | null
  level?: AiLogLevel | 'all'
}): Promise<AiLogRow[]> {
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 200))
  const conds: string[] = []
  const params: unknown[] = []

  if (opts?.sinceId) {
    params.push(opts.sinceId)
    conds.push(`id > $${params.length}`)
  }
  if (opts?.level && opts.level !== 'all') {
    const order: AiLogLevel[] = ['debug', 'info', 'warn', 'error']
    const allowed = order.slice(order.indexOf(opts.level))
    params.push(allowed)
    conds.push(`level = ANY($${params.length}::text[])`)
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  params.push(limit)

  try {
    const rows = await query<DbRow>(
      `SELECT id, created_at, level, source, event, message,
              conversation_id, channel_type, meta
         FROM ai_logs
         ${where}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    )
    return rows.map(mapRow)
  } catch {
    // Table may not be migrated yet — behave as an empty log.
    return []
  }
}

/** Wipe the log (admin "Очистить" action). Best-effort. */
export async function clearAiLogs(): Promise<void> {
  try {
    await query(`DELETE FROM ai_logs`)
  } catch {
    // ignore
  }
}
