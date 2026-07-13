import { randomUUID } from 'node:crypto'
import { query } from '@/lib/db'
import { makePersona } from './content'
import type { ChannelType } from '@/lib/types'
import type {
  LearnedProfile,
  SimOutcome,
  SimPersona,
  SimSettings,
  SimState,
  SimThreadRow,
  SimTone,
} from './types'

const TONES: readonly SimTone[] = ['polite', 'neutral', 'rough', 'mixed']

/* ------------------------------- settings ------------------------------- */

interface SettingsRow {
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
}

function mapSettings(r: SettingsRow): SimSettings {
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
  }
}

// Columns guaranteed to exist since migration 049.
const SETTINGS_COLS_BASE = `enabled, channel_ids, aggression, max_threads,
  spawn_min_sec, spawn_max_sec, reply_min_sec, reply_max_sec,
  next_spawn_at, spawned_total, replies_total, started_at, updated_at`
// Columns added by later, optional migrations (050: learned_profile,
// 051: tone, 055: dialogs_per_day, 061: max_concurrent). They may not exist
// yet on a given DB.
const OPTIONAL_SETTINGS_COLS = [
  'learned_profile',
  'tone',
  'dialogs_per_day',
  'max_concurrent',
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
const OPTIONAL_COLS_TTL_MS = 60_000
let optionalColsCache: { cols: Set<string>; expires: number } | null = null

async function getExistingOptionalCols(): Promise<Set<string>> {
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
      '[v0][client-sim] optional-column probe failed, assuming base schema:',
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
const OPTIONAL_THREAD_COLS = ['outcome', 'nudge_attempts', 'nudge_next_at'] as const
let threadColsCache: { cols: Set<string>; expires: number } | null = null

async function getExistingThreadCols(): Promise<Set<string>> {
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
async function hasThreadRealismCols(): Promise<boolean> {
  const cols = await getExistingThreadCols()
  return OPTIONAL_THREAD_COLS.every((c) => cols.has(c))
}

/**
 * Read the singleton settings row, creating it if missing. Selects only the
 * optional columns that actually exist (probed at runtime) and fills defaults
 * for the rest — so it works on any DB regardless of which migrations have run,
 * and never throws a 500 (or logs a scary query failure) that would take down
 * the whole god panel.
 */
export async function getSettings(): Promise<SimSettings> {
  const existing = await getExistingOptionalCols()
  const present = OPTIONAL_SETTINGS_COLS.filter((c) => existing.has(c))
  const cols = present.length
    ? `${SETTINGS_COLS_BASE}, ${present.join(', ')}`
    : SETTINGS_COLS_BASE

  const selectRow = async (): Promise<SettingsRow | undefined> => {
    const rows = await query<Partial<SettingsRow>>(
      `SELECT ${cols} FROM sim_settings WHERE id = true LIMIT 1`,
    )
    const r = rows[0]
    if (!r) return undefined
    // Fill defaults for any optional column not selected (missing on this DB).
    return {
      learned_profile: null,
      tone: 'mixed',
      dialogs_per_day: 20,
      max_concurrent: 100,
      ...r,
    } as SettingsRow
  }

  const row = await selectRow()
  if (row) return mapSettings(row)
  await query(`INSERT INTO sim_settings (id) VALUES (true) ON CONFLICT DO NOTHING`)
  const again = await selectRow()
  return mapSettings(again as SettingsRow)
}

function isUndefinedColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: string }).code
  const msg = (err as { message?: string }).message ?? ''
  return (
    code === '42703' ||
    /learned_profile|\btone\b|dialogs_per_day|max_concurrent|column .* does not exist/i.test(msg)
  )
}

export interface SettingsPatch {
  enabled?: boolean
  channelIds?: string[]
  dialogsPerDay?: number
  maxConcurrent?: number
  aggression?: number
  tone?: SimTone
  maxThreads?: number
  spawnMinSec?: number
  spawnMaxSec?: number
  replyMinSec?: number
  replyMaxSec?: number
}

/**
 * Partial update of the settings row. Enabling stamps started_at.
 *
 * Assignments to columns added by optional migrations (`tone`, `dialogs_per_day`)
 * are marked optional: if the target column doesn't exist yet, the whole update
 * is transparently retried without the optional assignments so the rest still
 * lands instead of 500-ing.
 */
export async function updateSettings(patch: SettingsPatch): Promise<SimSettings> {
  // Each assignment is `col = $n`; `optional` ones are dropped on undefined_column.
  const assignments: Array<{ col: string; val: unknown; optional?: boolean }> = []
  // Raw SQL fragments with no bound params (e.g. now()).
  const rawSets: string[] = ['updated_at = now()']

  if (patch.enabled !== undefined) {
    assignments.push({ col: 'enabled', val: patch.enabled })
    // Stamp started_at the moment it flips on; keep the schedule primed so the
    // engine can spawn immediately rather than waiting a full cycle.
    if (patch.enabled) rawSets.push('started_at = now()', 'next_spawn_at = now()')
  }
  if (patch.channelIds !== undefined)
    assignments.push({ col: 'channel_ids', val: patch.channelIds })
  if (patch.dialogsPerDay !== undefined)
    assignments.push({
      col: 'dialogs_per_day',
      val: clampInt(patch.dialogsPerDay, 1, 5_000),
      optional: true,
    })
  if (patch.maxConcurrent !== undefined)
    assignments.push({
      col: 'max_concurrent',
      val: clampInt(patch.maxConcurrent, 1, 1_000),
      optional: true,
    })
  if (patch.aggression !== undefined)
    assignments.push({ col: 'aggression', val: clampInt(patch.aggression, 0, 100) })
  if (patch.maxThreads !== undefined)
    // 0 means unlimited. No upper bound enforced here.
    assignments.push({ col: 'max_threads', val: Math.max(0, Math.floor(patch.maxThreads) || 0) })
  if (patch.spawnMinSec !== undefined)
    assignments.push({ col: 'spawn_min_sec', val: clampInt(patch.spawnMinSec, 5, 86_400) })
  if (patch.spawnMaxSec !== undefined)
    assignments.push({ col: 'spawn_max_sec', val: clampInt(patch.spawnMaxSec, 5, 86_400) })
  if (patch.replyMinSec !== undefined)
    assignments.push({ col: 'reply_min_sec', val: clampInt(patch.replyMinSec, 1, 86_400) })
  if (patch.replyMaxSec !== undefined)
    assignments.push({ col: 'reply_max_sec', val: clampInt(patch.replyMaxSec, 1, 86_400) })
  if (patch.tone !== undefined)
    assignments.push({
      col: 'tone',
      val: TONES.includes(patch.tone) ? patch.tone : 'mixed',
      optional: true,
    })

  const run = async (list: typeof assignments) => {
    const params: unknown[] = []
    const sets = [...rawSets]
    for (const a of list) {
      params.push(a.val)
      sets.push(`${a.col} = $${params.length}`)
    }
    await query(`UPDATE sim_settings SET ${sets.join(', ')} WHERE id = true`, params)
  }

  // Drop assignments to optional columns that don't exist on this DB, so we
  // never reference a missing column (the runtime probe is authoritative).
  const existing = await getExistingOptionalCols()
  const effective = assignments.filter((a) => !a.optional || existing.has(a.col))

  try {
    await run(effective)
  } catch (err) {
    const hasOptional = effective.some((a) => a.optional)
    if (hasOptional && isUndefinedColumn(err)) {
      // Backstop: if the probe was stale, retry without optional assignments so
      // the rest of the save still lands instead of 500-ing.
      optionalColsCache = null
      await run(effective.filter((a) => !a.optional))
    } else {
      throw err
    }
  }
  return getSettings()
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(n) || min, min), max)
}

/**
 * Atomically claim the next spawn slot. Returns true only for the single caller
 * that wins the race (guards against double-spawning across concurrent ticks).
 * On success it also reschedules the next spawn window. The `spawned_total`
 * counter is NOT bumped here — call `bumpSpawnedTotal()` once the conversation
 * is actually created so the stat only counts real spawns.
 */
export async function claimSpawnSlot(nextDelaySec: number): Promise<boolean> {
  const rows = await query<{ id: boolean }>(
    `UPDATE sim_settings
        SET next_spawn_at = now() + make_interval(secs => $1::int),
            updated_at = now()
      WHERE id = true
        AND enabled = true
        AND (next_spawn_at IS NULL OR next_spawn_at <= now())
      RETURNING id`,
    [Math.max(1, Math.floor(nextDelaySec))],
  )
  return rows.length > 0
}

/** Record that a conversation was actually spawned. */
export async function bumpSpawnedTotal(): Promise<void> {
  await query(
    `UPDATE sim_settings SET spawned_total = spawned_total + 1, updated_at = now() WHERE id = true`,
  )
}

export async function bumpRepliesTotal(): Promise<void> {
  await query(
    `UPDATE sim_settings SET replies_total = replies_total + 1, updated_at = now() WHERE id = true`,
  )
}

/* ------------------- cross-thread anti-repetition memory ---------------- */

/**
 * A process-wide ring buffer of the most recent lines the bots actually sent
 * across ALL conversations. Per-thread history already stops a single persona
 * repeating itself; this catches the population-level tell where many "clients"
 * independently send the same phrase. The generator consults it to avoid
 * reusing anything the swarm just said, so bots never get caught echoing each
 * other or firing identical replies at the same time.
 */
const GLOBAL_LINE_MEMORY_SIZE = 80
const g = globalThis as unknown as { __simGlobalLines?: string[] }

function globalLines(): string[] {
  if (!g.__simGlobalLines) g.__simGlobalLines = []
  return g.__simGlobalLines
}

/** Record a line the swarm just sent (deduped, capped). */
export function rememberGlobalLine(line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  const buf = globalLines()
  buf.push(trimmed)
  if (buf.length > GLOBAL_LINE_MEMORY_SIZE) {
    buf.splice(0, buf.length - GLOBAL_LINE_MEMORY_SIZE)
  }
}

/** The most recent `n` lines sent anywhere, newest last. */
export function getGlobalRecentLines(n = 40): string[] {
  const buf = globalLines()
  return buf.slice(-Math.max(0, n))
}

/* ------------------------------- threads -------------------------------- */

interface ThreadRow {
  conversation_id: string
  channel_id: string
  persona: SimPersona
  state: SimState
  turns: number
  last_seen_out: string | null
  next_run_at: string | Date | null
  outcome?: SimOutcome | null
  nudge_attempts?: number | null
}

function mapThread(r: ThreadRow): SimThreadRow {
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
  }
}

/** Count of live (non-done) bot threads. */
export async function countActiveThreads(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sim_threads WHERE state <> 'done'`,
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * Retire abandoned threads and close them out as `done`.
 *
 * Crucial distinction so we DON'T kill dialogues the simulator should keep
 * living:
 *   - CLIENT GHOSTED (last message is outbound = the manager spoke and the
 *     client never came back): this is genuine churn — a real person who lost
 *     interest. Reap after `clientGhostMinutes`.
 *   - WAITING ON THE MANAGER (last message is inbound = the client wrote and no
 *     reply came yet): this is NOT the client's fault. Previously these were
 *     reaped at 2h, which is exactly why a big backlog of dialogues the sim
 *     created "died" while the AI manager was catching up — once `done`, the
 *     reaction/backlog sweeps skip them forever. We now KEEP these alive so the
 *     backlog sweep can still get them answered, and only close them via a much
 *     longer `hardCapMinutes` safety valve so nothing piles up truly unbounded.
 *
 * Returns the number of threads closed so the caller can surface it in the logs.
 */
export async function expireStaleThreads(
  clientGhostMinutes = 180,
  hardCapMinutes = 2880, // 48h absolute backstop regardless of who spoke last
): Promise<number> {
  const hasOutcome = await hasThreadRealismCols()
  // When the realism columns exist we also stamp WHY it closed:
  //   - client-ghost branch → 'ghosted'
  //   - hard-cap backstop    → 'ended'
  const outcomeSet = hasOutcome
    ? `, outcome = CASE
             WHEN l.last_dir = 'out'
                  AND l.updated_at < now() - ($1 || ' minutes')::interval
             THEN 'ghosted' ELSE 'ended' END`
    : ''
  const rows = await query<{ n: string }>(
    `WITH latest AS (
       SELECT t.conversation_id, t.updated_at, t.state,
              m.direction AS last_dir
         FROM sim_threads t
         JOIN LATERAL (
           SELECT direction
             FROM messages
            WHERE conversation_id = t.conversation_id
            ORDER BY created_at DESC
            LIMIT 1
         ) m ON true
        WHERE t.state <> 'done'
     ),
     reaped AS (
       UPDATE sim_threads t
          SET state = 'done', next_run_at = NULL, updated_at = now()${outcomeSet}
         FROM latest l
        WHERE t.conversation_id = l.conversation_id
          AND (
            -- client ghosted: manager spoke last, client never returned.
            -- Only applies to states where the manager owes / active chat —
            -- NOT to 'later'/'sleeping'/'vanished', which have a legitimate
            -- future return scheduled in next_run_at and must not be reaped.
            (l.last_dir = 'out'
             AND l.state IN ('opening', 'chatting', 'ignoring')
             AND l.updated_at < now() - ($1 || ' minutes')::interval)
            -- absolute safety valve: anything ancient, whoever spoke last
            OR l.updated_at < now() - ($2 || ' minutes')::interval
          )
       RETURNING t.conversation_id
     )
     SELECT count(*)::text AS n FROM reaped`,
    [
      String(Math.max(1, Math.round(clientGhostMinutes))),
      String(Math.max(1, Math.round(hardCapMinutes))),
    ],
  )
  return Number(rows[0]?.n ?? 0)
}

/** Threads-per-state breakdown for the dashboard. */
export async function threadsByState(): Promise<Record<SimState, number>> {
  const rows = await query<{ state: SimState; n: string }>(
    `SELECT state, count(*)::text AS n FROM sim_threads GROUP BY state`,
  )
  const out: Record<SimState, number> = {
    opening: 0,
    chatting: 0,
    ignoring: 0,
    later: 0,
    sleeping: 0,
    vanished: 0,
    done: 0,
  }
  for (const r of rows) {
    if (r.state in out) out[r.state] = Number(r.n)
  }
  return out
}

/**
 * Finished dialogues grouped by outcome (the client's "fate"). Returns all-zero
 * counts on a DB that hasn't applied migration 061 yet.
 */
export async function threadsByOutcome(): Promise<Record<SimOutcome, number>> {
  const out: Record<SimOutcome, number> = {
    ended: 0,
    left: 0,
    competitor: 0,
    ghosted: 0,
    angry: 0,
  }
  if (!(await hasThreadRealismCols())) return out
  const rows = await query<{ outcome: SimOutcome | null; n: string }>(
    `SELECT outcome, count(*)::text AS n
       FROM sim_threads
      WHERE state = 'done' AND outcome IS NOT NULL
      GROUP BY outcome`,
  )
  for (const r of rows) {
    if (r.outcome && r.outcome in out) out[r.outcome] = Number(r.n)
  }
  return out
}

/**
 * Claim due threads for processing. A thread is "due" when its next_run_at has
 * passed. We atomically push next_run_at into the future so a second concurrent
 * tick won't grab the same rows.
 */
export async function claimDueThreads(limit: number): Promise<SimThreadRow[]> {
  const rows = await query<ThreadRow>(
    `UPDATE sim_threads t
        SET next_run_at = now() + interval '2 minutes', updated_at = now()
      WHERE t.conversation_id IN (
        SELECT conversation_id FROM sim_threads
         WHERE state <> 'done'
           AND next_run_at IS NOT NULL
           AND next_run_at <= now()
         ORDER BY next_run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING conversation_id, channel_id, persona, state, turns, last_seen_out, next_run_at`,
    [Math.max(1, limit)],
  )
  return rows.map(mapThread)
}

/**
 * Find threads whose owning manager has replied since we last looked, i.e. the
 * latest message is inbound-less: an 'out' message newer than last_seen_out.
 * Returns the thread plus the triggering manager message so the engine can
 * schedule a human-like delayed reaction.
 */
export interface PendingManagerReply {
  thread: SimThreadRow
  managerMessageId: string
  managerBody: string
}

export async function findThreadsAwaitingReaction(
  limit: number,
): Promise<PendingManagerReply[]> {
  const rows = await query<
    ThreadRow & { m_id: string; m_body: string }
  >(
    `SELECT t.conversation_id, t.channel_id, t.persona, t.state, t.turns,
            t.last_seen_out, t.next_run_at,
            m.id AS m_id, m.body AS m_body
       FROM sim_threads t
       JOIN LATERAL (
         SELECT id, body
           FROM messages
          WHERE conversation_id = t.conversation_id
            AND direction = 'out'
          ORDER BY created_at DESC
          LIMIT 1
       ) m ON true
      WHERE t.state IN ('opening', 'chatting', 'ignoring')
        AND (t.last_seen_out IS NULL OR m.id <> t.last_seen_out)
      ORDER BY t.updated_at ASC
      LIMIT $1`,
    [Math.max(1, limit)],
  )
  return rows.map((r) => ({
    thread: mapThread(r),
    managerMessageId: r.m_id,
    managerBody: r.m_body,
  }))
}

/**
 * Find simulated conversations that are stuck waiting on the AI manager: the
 * thread is still live and the LATEST message is inbound (from the client), so
 * the client sent something and no manager reply followed. These are the "old
 * hanging dialogues" — they were created before the AI-trigger wiring existed,
 * or the manager call failed at the time, so nothing ever nudged the AI again.
 *
 * `staleSeconds` skips very fresh messages so we don't race the normal trigger
 * that already fires right after a client posts. Returns the last client line
 * so the engine can hand it to the manager exactly like a fresh inbound.
 */
export interface StuckConversation {
  conversationId: string
  lastClientBody: string
}

export async function findConversationsAwaitingManager(
  limit: number,
  staleSeconds = 90,
): Promise<StuckConversation[]> {
  // Per-conversation backoff: once 061 is applied, skip a dialogue until its
  // nudge_next_at arrives so a manager that never answers (e.g. master switch
  // off) isn't poked every tick forever.
  const backoffClause = (await hasThreadRealismCols())
    ? 'AND (t.nudge_next_at IS NULL OR t.nudge_next_at <= now())'
    : ''
  const rows = await query<{ conversation_id: string; body: string }>(
    `SELECT t.conversation_id, m.body
       FROM sim_threads t
       JOIN LATERAL (
         SELECT direction, body, created_at
           FROM messages
          WHERE conversation_id = t.conversation_id
          ORDER BY created_at DESC
          LIMIT 1
       ) m ON true
      WHERE t.state IN ('opening', 'chatting')
        AND m.direction = 'in'
        AND m.created_at < now() - make_interval(secs => $2::int)
        ${backoffClause}
      ORDER BY t.updated_at ASC
      LIMIT $1`,
    [Math.max(1, limit), Math.max(0, Math.floor(staleSeconds))],
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    lastClientBody: r.body,
  }))
}

/**
 * Record that we poked the AI manager for this dialogue without visible
 * progress: bump the attempt counter and push the next allowed nudge out
 * exponentially (90s, 3m, 9m, 27m … capped ~2h). Reset by
 * `scheduleReaction`/`markLatestOutSeen` the moment the manager actually
 * replies. No-op on a pre-061 DB.
 */
export async function bumpNudgeBackoff(conversationId: string): Promise<void> {
  if (!(await hasThreadRealismCols())) {
    // Fall back to the old rotate-to-back behaviour so the backlog still cycles.
    await touchThread(conversationId)
    return
  }
  await query(
    `UPDATE sim_threads
        SET nudge_attempts = nudge_attempts + 1,
            nudge_next_at = now() + make_interval(
              secs => LEAST(7200, 90 * power(3, LEAST(nudge_attempts, 5))::int)
            ),
            updated_at = now()
      WHERE conversation_id = $1`,
    [conversationId],
  )
}

/**
 * Mark the latest manager (out) message as "seen" and clear any nudge backoff —
 * called after the client actually replies, so the reaction sweep doesn't
 * double-fire and the backoff resets on real progress. No-op on a pre-061 DB
 * for the backoff reset; the last_seen_out update always runs.
 */
export async function markLatestOutSeen(conversationId: string): Promise<void> {
  const resetBackoff = (await hasThreadRealismCols())
    ? ', nudge_attempts = 0, nudge_next_at = NULL'
    : ''
  await query(
    `UPDATE sim_threads t
        SET last_seen_out = COALESCE(
              (SELECT id FROM messages
                WHERE conversation_id = $1 AND direction = 'out'
                ORDER BY created_at DESC LIMIT 1),
              t.last_seen_out
            ),
            updated_at = now()${resetBackoff}
      WHERE t.conversation_id = $1`,
    [conversationId],
  )
}

/**
 * Bump a thread's `updated_at` without changing anything else. Used by the
 * backlog sweep so re-nudged dialogues rotate to the back of the queue and the
 * whole backlog gets a fair turn instead of hammering the same few.
 */
export async function touchThread(conversationId: string): Promise<void> {
  await query(
    `UPDATE sim_threads SET updated_at = now() WHERE conversation_id = $1`,
    [conversationId],
  )
}

/** Mark that we've seen a manager message and schedule a delayed reaction. */
export async function scheduleReaction(
  conversationId: string,
  managerMessageId: string,
  delaySec: number,
): Promise<void> {
  await query(
    `UPDATE sim_threads
        SET last_seen_out = $2,
            next_run_at = now() + make_interval(secs => $3::int),
            updated_at = now()
      WHERE conversation_id = $1`,
    [conversationId, managerMessageId, Math.max(1, Math.floor(delaySec))],
  )
}

/** Persist a thread's new state / schedule after the engine acts on it. */
export async function updateThread(
  conversationId: string,
  patch: { state?: SimState; turns?: number; nextRunAt?: string | null },
): Promise<void> {
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = [conversationId]
  if (patch.state !== undefined) {
    params.push(patch.state)
    sets.push(`state = $${params.length}`)
  }
  if (patch.turns !== undefined) {
    params.push(patch.turns)
    sets.push(`turns = $${params.length}`)
  }
  if (patch.nextRunAt !== undefined) {
    if (patch.nextRunAt === null) {
      sets.push(`next_run_at = NULL`)
    } else {
      params.push(patch.nextRunAt)
      sets.push(`next_run_at = $${params.length}`)
    }
  }
  await query(`UPDATE sim_threads SET ${sets.join(', ')} WHERE conversation_id = $1`, params)
}

/* --------------------------- conversation I/O --------------------------- */

/** Channels the bot may use: only those with an assigned manager. */
export interface SimChannel {
  id: string
  type: ChannelType
  managerId: string
}

export async function listUsableChannels(
  channelIds: string[],
): Promise<SimChannel[]> {
  const idFilter = channelIds.length ? channelIds : null
  const rows = await query<{ id: string; type: ChannelType; manager_id: string }>(
    `SELECT id, type, manager_id
       FROM channels
      WHERE manager_id IS NOT NULL
        AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`,
    [idFilter],
  )
  return rows.map((r) => ({ id: r.id, type: r.type, managerId: r.manager_id }))
}

/**
 * Create a brand-new conversation for a persona, seeded with its opening
 * message, and register the bot thread.
 *
 * This is deliberately byte-for-byte equivalent to how the WHATSAPP/TELEGRAM/VK
 * worker writes a genuine first inbound message (see worker/src/repo.ts):
 *   - `status` is left NULL (auto-derived as "new" from unread) — we must NOT
 *     set a literal status, both because real inbound leaves it NULL and
 *     because the post-035 CHECK constraint rejects legacy values like 'new'.
 *   - `contact_username` is populated for telegram/vk just like the real path.
 *   - the conversation is seeded with the first message body + unread=1 in one
 *     shot, so it never flashes into the manager's list as an empty thread.
 * The result is indistinguishable from an organic incoming conversation.
 */
export async function createSimConversation(
  channel: SimChannel,
  persona: SimPersona,
  firstBody: string,
): Promise<string> {
  const convId = randomUUID()
  const contactUsername = persona.username ?? null
  await query(
    `INSERT INTO conversations
       (id, channel_id, channel_type, manager_id, contact_name, contact_handle,
        contact_username, last_message, last_message_at, unread)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 1)`,
    [
      convId,
      channel.id,
      channel.type,
      channel.managerId,
      persona.name,
      persona.username ? `@${persona.username}` : persona.handle,
      contactUsername,
      firstBody,
    ],
  )
  await query(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, 'in', $3, $4)`,
    [randomUUID(), convId, firstBody, persona.name],
  )
  await query(
    `INSERT INTO sim_threads (conversation_id, channel_id, persona, state, next_run_at)
     VALUES ($1, $2, $3::jsonb, 'opening', now())`,
    [convId, channel.id, JSON.stringify(persona)],
  )
  return convId
}

/**
 * Insert an inbound (client) message exactly like secretSendAsClientAction —
 * same tables + triggers, so the manager sees it arrive live and it is
 * completely indistinguishable from a genuine incoming message.
 */
export async function insertInboundMessage(
  conversationId: string,
  author: string,
  body: string,
): Promise<void> {
  await query(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, 'in', $3, $4)`,
    [randomUUID(), conversationId, body, author],
  )
  await query(
    `UPDATE conversations
        SET last_message = $2, last_message_at = now(), unread = unread + 1
      WHERE id = $1`,
    [conversationId, body],
  )
}

/**
 * Manager + channel a conversation routes to. Needed so the simulator can hand
 * a freshly-posted client message to the AI MANAGER through its normal public
 * entry point (exactly like a real channel webhook would), instead of poking at
 * the manager's brain directly — the two systems stay code-separate.
 */
export async function getConversationRouting(
  conversationId: string,
): Promise<{ managerId: string; channelId: string } | null> {
  const rows = await query<{ manager_id: string; channel_id: string }>(
    `SELECT manager_id, channel_id FROM conversations WHERE id = $1`,
    [conversationId],
  )
  const r = rows[0]
  return r ? { managerId: r.manager_id, channelId: r.channel_id } : null
}

/* ------------------- adopting real / existing dialogues ----------------- */
/*
 * By default the simulator only ever touches conversations IT created (rows in
 * sim_threads). Everything else — organic dialogues, and anything that existed
 * before an update — is invisible to the engine, so the bot never continues
 * them. "Adopting" a conversation simply registers a sim_threads row for it: the
 * engine then reads the FULL real transcript from `messages` and keeps the
 * dialogue going, in-character, on a human, randomised schedule.
 */

export interface AdoptableConversation {
  id: string
  channelType: ChannelType
  contactName: string
  managerId: string | null
  managerName: string | null
  lastMessage: string | null
  lastMessageAt: string | null
  messageCount: number
  /** Who spoke last: 'in' = client, 'out' = manager. */
  lastDirection: 'in' | 'out' | null
  /** Already registered as a simulator thread. */
  adopted: boolean
}

/**
 * List conversations the simulator COULD take over: any conversation routed to
 * a manager. Each row carries the owning manager's name (for the grouped table),
 * a message count, the last message + who sent it, and whether it is already
 * adopted. Ordered newest-activity first.
 */
export async function listAdoptableConversations(
  limit = 1000,
): Promise<AdoptableConversation[]> {
  const rows = await query<{
    id: string
    channel_type: ChannelType
    contact_name: string | null
    manager_id: string | null
    manager_name: string | null
    last_message: string | null
    last_message_at: string | Date | null
    msg_count: number
    last_direction: 'in' | 'out' | null
    adopted: boolean
  }>(
    `SELECT c.id, c.channel_type, c.contact_name, c.manager_id,
            mgr.name AS manager_name,
            c.last_message, c.last_message_at,
            COALESCE(mc.n, 0) AS msg_count,
            lm.direction AS last_direction,
            (st.conversation_id IS NOT NULL) AS adopted
       FROM conversations c
       LEFT JOIN managers mgr ON mgr.id = c.manager_id
       LEFT JOIN sim_threads st ON st.conversation_id = c.id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n
           FROM messages m
          WHERE m.conversation_id = c.id
       ) mc ON true
       LEFT JOIN LATERAL (
         SELECT direction
           FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY created_at DESC
          LIMIT 1
       ) lm ON true
      WHERE c.manager_id IS NOT NULL
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $1`,
    [Math.max(1, limit)],
  )
  return rows.map((r) => ({
    id: r.id,
    channelType: r.channel_type,
    contactName: r.contact_name ?? 'Без имени',
    managerId: r.manager_id,
    managerName: r.manager_name,
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at
      ? new Date(r.last_message_at).toISOString()
      : null,
    messageCount: Number(r.msg_count ?? 0),
    lastDirection: r.last_direction,
    adopted: r.adopted,
  }))
}

export interface AdoptResult {
  adopted: number
  skipped: number
}

/**
 * Register simulator threads for the given existing conversations so the engine
 * continues them. For each conversation we:
 *   - synthesize a fresh random persona (tone/character rolled from settings)
 *     but pin its NAME/handle to the real contact, so the same person keeps
 *     talking rather than a stranger;
 *   - seed `turns` from the real client-message count so behaviour escalation
 *     picks up where the dialogue actually is;
 *   - pin `last_seen_out` to the latest manager message so the reaction sweep
 *     doesn't instantly fire on an old reply — we drive timing ourselves;
 *   - schedule `next_run_at` at a RANDOM offset within [minDelaySec, maxDelaySec]
 *     so the swarm revives dialogues staggered over time, never all at once.
 * Already-adopted conversations are skipped (idempotent via ON CONFLICT).
 */
export async function adoptConversations(
  conversationIds: string[],
  opts: {
    aggression: number
    tone: SimTone
    minDelaySec?: number
    maxDelaySec?: number
  },
): Promise<AdoptResult> {
  const ids = [...new Set(conversationIds)].filter(Boolean)
  if (ids.length === 0) return { adopted: 0, skipped: 0 }

  const seeds = await query<{
    id: string
    channel_id: string
    channel_type: ChannelType
    contact_name: string | null
    contact_handle: string | null
    contact_username: string | null
    last_out_id: string | null
    client_turns: number
    already: boolean
  }>(
    `SELECT c.id, c.channel_id, c.channel_type,
            c.contact_name, c.contact_handle, c.contact_username,
            lo.id AS last_out_id,
            COALESCE(ct.n, 0) AS client_turns,
            (st.conversation_id IS NOT NULL) AS already
       FROM conversations c
       LEFT JOIN sim_threads st ON st.conversation_id = c.id
       LEFT JOIN LATERAL (
         SELECT id
           FROM messages m
          WHERE m.conversation_id = c.id AND m.direction = 'out'
          ORDER BY created_at DESC
          LIMIT 1
       ) lo ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n
           FROM messages m
          WHERE m.conversation_id = c.id AND m.direction = 'in'
       ) ct ON true
      WHERE c.id = ANY($1::uuid[])
        AND c.manager_id IS NOT NULL`,
    [ids],
  )

  const minD = Math.max(5, Math.floor(opts.minDelaySec ?? 20))
  const maxD = Math.max(minD + 1, Math.floor(opts.maxDelaySec ?? 7200))

  let adopted = 0
  let skipped = 0
  for (const s of seeds) {
    if (s.already) {
      skipped += 1
      continue
    }
    const persona = makePersona(s.channel_type, opts.aggression, opts.tone)
    // Pin identity to the real contact so it reads as the same person.
    if (s.contact_name) persona.name = s.contact_name
    if (s.contact_handle) persona.handle = s.contact_handle
    persona.username = s.contact_username ?? persona.username

    const delay = minD + Math.floor(Math.random() * (maxD - minD))
    await query(
      `INSERT INTO sim_threads
         (conversation_id, channel_id, persona, state, turns, last_seen_out, next_run_at)
       VALUES ($1, $2, $3::jsonb, 'chatting', $4, $5, now() + make_interval(secs => $6::int))
       ON CONFLICT (conversation_id) DO NOTHING`,
      [
        s.id,
        s.channel_id,
        JSON.stringify(persona),
        Math.max(1, Number(s.client_turns ?? 1)),
        s.last_out_id,
        delay,
      ],
    )
    adopted += 1
  }
  // Any requested id not returned by the seed query (no manager / not found) is
  // counted as skipped so the UI total always reconciles.
  skipped += ids.length - seeds.length
  return { adopted, skipped }
}

/** Recent transcript for building LLM context (oldest→newest). */
export interface SimTranscriptLine {
  direction: 'in' | 'out'
  body: string
}

export async function getTranscript(
  conversationId: string,
  limit = 16,
): Promise<SimTranscriptLine[]> {
  const rows = await query<{ direction: 'in' | 'out'; body: string }>(
    `SELECT direction, body
       FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, limit],
  )
  return rows.reverse().map((r) => ({ direction: r.direction, body: r.body }))
}

/* ----------------------- real-dialogue style reference ------------------ */
/*
 * The bot studies how ACTUAL people wrote to managers and mimics that voice.
 * We sample short, genuine inbound lines per channel — explicitly excluding the
 * bot's own threads (sim_threads) so it never learns from itself — and cache
 * them in-process so generation stays cheap.
 */

const REF_TTL_MS = 10 * 60_000
const refCache = new Map<string, { lines: string[]; expires: number }>()

/**
 * Return up to `limit` real client message samples for a channel type, freshly
 * randomised and cached for a few minutes. Filters out media placeholders,
 * links, over-long paragraphs and anything from a simulated thread.
 */
export async function sampleRealClientLines(
  channelType: ChannelType,
  limit = 12,
): Promise<string[]> {
  const key = `${channelType}:${limit}`
  const hit = refCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.lines

  let lines: string[] = []
  try {
    const rows = await query<{ body: string }>(
      `SELECT m.body
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'in'
          AND c.channel_type = $1
          AND char_length(m.body) BETWEEN 2 AND 160
          AND m.body !~ '^\\['              -- skip "[фото]" / "[файл]" placeholders
          AND m.body !~* 'https?://'        -- skip links
          AND m.conversation_id NOT IN (SELECT conversation_id FROM sim_threads)
        ORDER BY random()
        LIMIT $2`,
      [channelType, Math.max(1, limit)],
    )
    lines = rows.map((r) => r.body.replace(/\s+/g, ' ').trim()).filter(Boolean)
  } catch (err) {
    console.log(
      '[v0][client-sim] reference sampling failed:',
      err instanceof Error ? err.message : String(err),
    )
  }

  refCache.set(key, { lines, expires: Date.now() + REF_TTL_MS })
  return lines
}

/* --------------------------- learning corpus ---------------------------- */
/*
 * "Изучить все диалоги": read whole real dialogues (client + manager turns) so
 * the analyzer can understand not just isolated phrases but the flow of a real
 * conversation. Bot-driven threads are excluded so it only studies humans.
 */

export interface CorpusDialogue {
  channelType: string
  lines: Array<{ role: 'client' | 'manager'; body: string }>
}

/**
 * Sample up to `maxDialogues` real conversations that have at least a couple of
 * messages, returning their transcripts (trimmed to `maxLinesPerDialogue`).
 */
export async function sampleRealDialogues(
  maxDialogues = 40,
  maxLinesPerDialogue = 12,
): Promise<CorpusDialogue[]> {
  const convs = await query<{ id: string; channel_type: string }>(
    `SELECT c.id, c.channel_type
       FROM conversations c
      WHERE c.id NOT IN (SELECT conversation_id FROM sim_threads)
        AND EXISTS (
          SELECT 1 FROM messages m
           WHERE m.conversation_id = c.id AND m.direction = 'in'
        )
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $1`,
    [Math.max(1, maxDialogues)],
  )
  if (convs.length === 0) return []

  const out: CorpusDialogue[] = []
  for (const c of convs) {
    const msgs = await query<{ direction: 'in' | 'out'; body: string }>(
      `SELECT direction, body
         FROM messages
        WHERE conversation_id = $1
          AND char_length(body) BETWEEN 1 AND 400
          AND body !~ '^\\['
        ORDER BY created_at ASC
        LIMIT $2`,
      [c.id, Math.max(2, maxLinesPerDialogue)],
    )
    const lines = msgs
      .map((m) => ({
        role: (m.direction === 'in' ? 'client' : 'manager') as 'client' | 'manager',
        body: m.body.replace(/\s+/g, ' ').trim(),
      }))
      .filter((l) => l.body)
    if (lines.some((l) => l.role === 'client')) {
      out.push({ channelType: c.channel_type, lines })
    }
  }
  return out
}

/** Persist the latest learned profile onto the singleton settings row. */
export async function saveLearnedProfile(profile: LearnedProfile): Promise<void> {
  await query(
    `UPDATE sim_settings
        SET learned_profile = $1::jsonb, updated_at = now()
      WHERE id = true`,
    [JSON.stringify(profile)],
  )
  // Refresh the generator cache immediately.
  learnedCache = { pointers: buildPointers(profile), expires: Date.now() + LEARN_TTL_MS }
}

/* -------- learned-profile cache consumed by the generator ---------------- */

const LEARN_TTL_MS = 5 * 60_000
let learnedCache: { pointers: string[]; expires: number } | null = null

function buildPointers(p: LearnedProfile | null): string[] {
  if (!p) return []
  // The most directly actionable signals for imitation.
  return [...p.stylePointers, ...p.toneNotes].filter(Boolean).slice(0, 12)
}

/**
 * Style pointers distilled by the last "learn" run, for injection into the
 * generator prompt. Cached in-process and refreshed lazily from the DB.
 */
export async function getLearnedPointersCached(): Promise<string[]> {
  if (learnedCache && learnedCache.expires > Date.now()) return learnedCache.pointers
  let pointers: string[] = []
  try {
    const rows = await query<{ learned_profile: LearnedProfile | null }>(
      `SELECT learned_profile FROM sim_settings WHERE id = true LIMIT 1`,
    )
    pointers = buildPointers(rows[0]?.learned_profile ?? null)
  } catch {
    pointers = []
  }
  learnedCache = { pointers, expires: Date.now() + LEARN_TTL_MS }
  return pointers
}
