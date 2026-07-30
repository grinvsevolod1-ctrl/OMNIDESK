import { query } from '@/lib/db'
import type {
  LearnedProfile,
  SimOutcome,
  SimPersona,
  SimSettings,
  SimState,
  SimThreadRow,
  SimTone,
} from '../types'

/**
 * Internal, package-private helpers for the client-simulator store, extracted
 * from lib/client-sim/store.ts. These are the shared row shapes, runtime
 * schema/column probes (with their short-TTL caches), and row→domain mappers
 * used by the per-domain store modules (settings / campaign / threads /
 * conversations / transcript). Not part of the public store API — consumers
 * import the store barrel, never this file.
 */

export const TONES: readonly SimTone[] = ['polite', 'neutral', 'rough', 'mixed']

/* ------------------------------- settings ------------------------------- */

export interface SettingsRow {
  enabled: boolean
  channel_ids: string[]
  aggression: number
  max_threads: number
  spawn_min_sec: number
  spawn_max_sec: number
  reply_min_sec: number
  reply_max_sec: number
  next_spawn_at: string | Date | null
  spawned_total: number
  replies_total: number
  started_at: string | Date | null
  updated_at: string | Date
  learned_profile: LearnedProfile | null
  tone: SimTone
  dialogs_per_day: number
  max_concurrent: number
  campaign_active: boolean
  campaign_target: number
  campaign_ends_at: string | Date | null
  campaign_started_at: string | Date | null
  campaign_baseline: number
}

export function mapSettings(r: SettingsRow): SimSettings {
  return {
    enabled: r.enabled,
    channelIds: r.channel_ids ?? [],
    dialogsPerDay: r.dialogs_per_day ?? 20,
    maxConcurrent: r.max_concurrent ?? 100,
    aggression: r.aggression,
    maxThreads: r.max_threads,
    spawnMinSec: r.spawn_min_sec,
    spawnMaxSec: r.spawn_max_sec,
    replyMinSec: r.reply_min_sec,
    replyMaxSec: r.reply_max_sec,
    spawnedTotal: r.spawned_total,
    repliesTotal: r.replies_total,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    updatedAt: new Date(r.updated_at).toISOString(),
    learnedProfile: r.learned_profile ?? null,
    tone: r.tone ?? 'mixed',
    campaignActive: r.campaign_active ?? false,
    campaignTarget: r.campaign_target ?? 0,
    campaignEndsAt: r.campaign_ends_at
      ? new Date(r.campaign_ends_at).toISOString()
      : null,
    campaignStartedAt: r.campaign_started_at
      ? new Date(r.campaign_started_at).toISOString()
      : null,
    campaignBaseline: r.campaign_baseline ?? 0,
  }
}

// Columns guaranteed to exist since migration 049.
export const SETTINGS_COLS_BASE = `enabled, channel_ids, aggression, max_threads,
  spawn_min_sec, spawn_max_sec, reply_min_sec, reply_max_sec,
  next_spawn_at, spawned_total, replies_total, started_at, updated_at`
// Columns added by later, optional migrations (050: learned_profile,
// 051: tone, 055: dialogs_per_day, 061: max_concurrent). They may not exist
// yet on a given DB.
export const OPTIONAL_SETTINGS_COLS = [
  'learned_profile',
  'tone',
  'dialogs_per_day',
  'max_concurrent',
  'campaign_active',
  'campaign_target',
  'campaign_ends_at',
  'campaign_started_at',
  'campaign_baseline',
] as const

/**
 * Which optional columns actually exist on the `sim_settings` table THIS
 * connection resolves to. Probed at runtime rather than assumed from migration
 * files, so we never issue a query that references a missing column — doing so
 * spams `[db] Query failed` even when we recover, and is the exact symptom seen
 * when the app's DB (or search_path) points at a table without the newer
 * columns despite the migration "having run" elsewhere.
 *
 * `to_regclass('sim_settings')` resolves the table the SAME way the real queries
 * do (through search_path), so the probe and the queries can never disagree —
 * even if another schema holds a stale `sim_settings`. Cached with a short TTL
 * so a freshly-applied migration is picked up automatically, no redeploy needed.
 */
export const OPTIONAL_COLS_TTL_MS = 60_000
let optionalColsCache: { cols: Set<string>; expires: number } | null = null

/** Drop the cached optional-column probe (e.g. after a schema-affecting reset). */
export function resetOptionalColsCache(): void {
  optionalColsCache = null
}

export async function getExistingOptionalCols(): Promise<Set<string>> {
  if (optionalColsCache && optionalColsCache.expires > Date.now()) {
    return optionalColsCache.cols
  }
  let cols = new Set<string>()
  try {
    const rows = await query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass('sim_settings')
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attname = ANY($1)`,
      [OPTIONAL_SETTINGS_COLS as unknown as string[]],
    )
    cols = new Set(rows.map((r) => r.column_name))
  } catch (err) {
    // If even the probe fails, assume the safe base schema (no optional cols).
    console.log(
      '[client-sim] optional-column probe failed, assuming base schema:',
      err instanceof Error ? err.message : String(err),
    )
  }
  optionalColsCache = { cols, expires: Date.now() + OPTIONAL_COLS_TTL_MS }
  return cols
}

/**
 * Columns added to `sim_threads` by migration 061 (outcome + nudge backoff).
 * Probed the same way as the settings columns so a DB that hasn't applied 061
 * yet degrades gracefully (the engine falls back to pre-061 behaviour) instead
 * of spamming `[db] Query failed` and taking the whole loop down.
 */
export const OPTIONAL_THREAD_COLS = ['outcome', 'nudge_attempts', 'nudge_next_at'] as const
let threadColsCache: { cols: Set<string>; expires: number } | null = null

export async function getExistingThreadCols(): Promise<Set<string>> {
  if (threadColsCache && threadColsCache.expires > Date.now()) {
    return threadColsCache.cols
  }
  let cols = new Set<string>()
  try {
    const rows = await query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass('sim_threads')
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attname = ANY($1)`,
      [OPTIONAL_THREAD_COLS as unknown as string[]],
    )
    cols = new Set(rows.map((r) => r.column_name))
  } catch {
    // Probe failed — assume the base schema (no realism columns).
  }
  threadColsCache = { cols, expires: Date.now() + OPTIONAL_COLS_TTL_MS }
  return cols
}

/** True once migration 061's sim_threads columns are present. */
export async function hasThreadRealismCols(): Promise<boolean> {
  const cols = await getExistingThreadCols()
  return OPTIONAL_THREAD_COLS.every((c) => cols.has(c))
}

/**
 * Whether migration 073's `paused` column exists on `sim_threads`. Probed the
 * same graceful way as the other optional columns so per-conversation pause
 * (operator stepping into a single dialogue) works once 073 is applied and
 * silently no-ops before then, without ever issuing a query for a missing
 * column. Cached with the same short TTL.
 */
let threadPauseColCache: { present: boolean; expires: number } | null = null

export async function hasThreadPauseCol(): Promise<boolean> {
  if (threadPauseColCache && threadPauseColCache.expires > Date.now()) {
    return threadPauseColCache.present
  }
  let present = false
  try {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass('sim_threads')
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attname = 'paused'`,
    )
    present = Number(rows[0]?.n ?? 0) > 0
  } catch {
    present = false
  }
  threadPauseColCache = { present, expires: Date.now() + OPTIONAL_COLS_TTL_MS }
  return present
}

export function isUndefinedColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: string }).code
  const msg = (err as { message?: string }).message ?? ''
  return (
    code === '42703' ||
    /learned_profile|\btone\b|dialogs_per_day|max_concurrent|campaign_|column .* does not exist/i.test(msg)
  )
}

export function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(n) || min, min), max)
}

export interface ThreadRow {
  conversation_id: string
  channel_id: string
  persona: SimPersona
  state: SimState
  turns: number
  last_seen_out: string | null
  next_run_at: string | Date | null
  outcome?: SimOutcome | null
  nudge_attempts?: number | null
  paused?: boolean | null
}

export function mapThread(r: ThreadRow): SimThreadRow {
  return {
    conversationId: r.conversation_id,
    channelId: r.channel_id,
    persona: r.persona,
    state: r.state,
    turns: r.turns,
    lastSeenOut: r.last_seen_out,
    nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
    outcome: r.outcome ?? null,
    nudgeAttempts: r.nudge_attempts ?? 0,
    paused: r.paused ?? false,
  }
}

export function readPersonaName(persona: unknown): string | null {
  if (persona && typeof persona === 'object' && 'name' in persona) {
    const n = (persona as { name?: unknown }).name
    if (typeof n === 'string' && n.trim()) return n
  }
  return null
}
