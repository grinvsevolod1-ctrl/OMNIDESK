import { randomUUID } from 'node:crypto'
import { query } from '@/lib/db'
import type { ChannelType } from '@/lib/types'
import type {
  LearnedProfile,
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
}

function mapSettings(r: SettingsRow): SimSettings {
  return {
    enabled: r.enabled,
    channelIds: r.channel_ids ?? [],
    dialogsPerDay: r.dialogs_per_day ?? 20,
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
// 051: tone, 055: dialogs_per_day). They may not exist yet on a given DB.
const OPTIONAL_SETTINGS_COLS = ['learned_profile', 'tone', 'dialogs_per_day'] as const

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
    /learned_profile|\btone\b|dialogs_per_day|column .* does not exist/i.test(msg)
  )
}

export interface SettingsPatch {
  enabled?: boolean
  channelIds?: string[]
  dialogsPerDay?: number
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
  }
}

/** Count of live (non-done) bot threads. */
export async function countActiveThreads(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sim_threads WHERE state <> 'done'`,
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
    done: 0,
  }
  for (const r of rows) out[r.state] = Number(r.n)
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
      WHERE t.state <> 'done'
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
