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

/**
 * Two fully independent log streams share the table but MUST NEVER be shown
 * together — they belong to unrelated systems:
 *   - 'ai'  → the AI manager that talks to real clients (sources: brain,
 *             ai-lead, handoff, worker). Visible in the normal admin panel.
 *   - 'sim' → the SECRET client simulator (source: sim). God-panel only —
 *             it must never leak into the ordinary admin UI.
 * Every read/clear is scoped so the two can't cross-contaminate.
 */
export type AiLogScope = 'ai' | 'sim'

/** Sources that belong to the secret simulator stream. */
const SIM_SOURCES = ['sim']

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

// ── Micro-batched write path ──────────────────────────────────────────────────
// Entries are buffered in-process and flushed as ONE multi-row INSERT, so a
// burst of log calls costs a single round-trip and the caller NEVER waits on
// the database. This is what fixed the ">500ms slow INSERT" reports: even
// callers that `await logAi(...)` on hot paths now return immediately — the
// write happens behind a short timer off the request path.

/** Flush after this many buffered entries, or after FLUSH_AFTER_MS — whichever
 * comes first. 20 rows / 250ms keeps the "Логи" tab effectively real-time. */
const FLUSH_AT = 20
const FLUSH_AFTER_MS = 250
/** Hard cap on buffered entries while the DB is down/unmigrated: drop the
 * OLDEST beyond this so diagnostics can never leak memory unbounded. */
const BUFFER_CAP = 500
/** Trim roughly every N flushes (not every insert as before). */
const TRIM_EVERY_FLUSHES = 25

type PendingRow = [
  string, // level
  string, // source
  string, // event
  string, // message
  string | null, // conversation_id
  string | null, // channel_type
  string | null, // meta json
]

// Module-level state; survives across requests within one server process.
// (Reused across hot reloads is unnecessary — worst case a dev reload drops a
// few buffered diagnostics rows.)
const buffer: PendingRow[] = []
let flushTimer: NodeJS.Timeout | null = null
let flushing = false
let flushCount = 0

async function flushNow(): Promise<void> {
  if (flushing) return // a running flush will pick up late rows via re-check
  flushing = true
  try {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, FLUSH_AT * 5)
      // One statement per batch: unnest zips the per-column arrays into rows.
      await query(
        `INSERT INTO ai_logs
           (level, source, event, message, conversation_id, channel_type, meta)
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[],
           $5::uuid[], $6::text[], $7::jsonb[]
         )`,
        [0, 1, 2, 3, 4, 5, 6].map((col) => batch.map((row) => row[col])),
      )
      flushCount++
      if (flushCount % TRIM_EVERY_FLUSHES === 0) {
        // Watermark trim: a pure PK range delete (no OFFSET walk). bigserial
        // ids may have gaps, so 2×MAX_ROWS keeps AT LEAST MAX_ROWS live rows;
        // the point is a bound, not an exact count.
        await query(
          `DELETE FROM ai_logs
            WHERE id < (SELECT COALESCE(max(id), 0) FROM ai_logs) - $1`,
          [MAX_ROWS * 2],
        )
      }
    }
  } catch {
    // Diagnostics must never break the observed path. Rows still in `buffer`
    // will ride along with the next flush; rows in the failed batch are lost.
  } finally {
    flushing = false
  }
}

function scheduleFlush(): void {
  if (buffer.length >= FLUSH_AT) {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    void flushNow()
    return
  }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNow()
  }, FLUSH_AFTER_MS)
  // Never keep the process alive just to write diagnostics.
  flushTimer.unref?.()
}

/**
 * Append one entry. Fire-and-forget friendly: callers may `void logAi(...)`.
 * Resolves IMMEDIATELY — the row is buffered and written in a micro-batch off
 * the caller's path. Swallows every error (including a not-yet-migrated
 * table) so it is always safe to call from hot paths.
 */
export async function logAi(input: AiLogInput): Promise<void> {
  try {
    buffer.push([
      input.level ?? 'info',
      input.source ?? 'ai',
      input.event,
      (input.message ?? '').slice(0, 4000),
      input.conversationId ?? null,
      input.channelType ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
    ])
    if (buffer.length > BUFFER_CAP) buffer.splice(0, buffer.length - BUFFER_CAP)
    scheduleFlush()
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
  scope?: AiLogScope
}): Promise<AiLogRow[]> {
  const limit = Math.max(1, Math.min(500, opts?.limit ?? 200))
  const conds: string[] = []
  const params: unknown[] = []

  // Scope is mandatory in practice: 'ai' excludes the simulator sources, 'sim'
  // includes only them. Defaults to 'ai' so an unscoped call can never leak
  // secret simulator activity into the normal admin panel.
  const scope: AiLogScope = opts?.scope ?? 'ai'
  params.push(SIM_SOURCES)
  conds.push(
    scope === 'sim'
      ? `source = ANY($${params.length}::text[])`
      : `NOT (source = ANY($${params.length}::text[]))`,
  )

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

/**
 * Wipe one log stream (admin "Очистить" action). Best-effort. Scoped so
 * clearing the AI-manager log never touches the secret simulator log and vice
 * versa.
 */
export async function clearAiLogs(scope: AiLogScope = 'ai'): Promise<void> {
  try {
    await query(
      scope === 'sim'
        ? `DELETE FROM ai_logs WHERE source = ANY($1::text[])`
        : `DELETE FROM ai_logs WHERE NOT (source = ANY($1::text[]))`,
      [SIM_SOURCES],
    )
  } catch {
    // ignore
  }
}
