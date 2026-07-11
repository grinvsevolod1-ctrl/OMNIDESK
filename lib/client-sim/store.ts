import { randomUUID } from 'node:crypto'
import { query } from '@/lib/db'
import type { ChannelType } from '@/lib/types'
import type {
  SimPersona,
  SimSettings,
  SimState,
  SimThreadRow,
} from './types'

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
}

function mapSettings(r: SettingsRow): SimSettings {
  return {
    enabled: r.enabled,
    channelIds: r.channel_ids ?? [],
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
  }
}

const SETTINGS_COLS = `enabled, channel_ids, aggression, max_threads,
  spawn_min_sec, spawn_max_sec, reply_min_sec, reply_max_sec,
  next_spawn_at, spawned_total, replies_total, started_at, updated_at`

/** Read the singleton settings row, creating it if missing. */
export async function getSettings(): Promise<SimSettings> {
  const rows = await query<SettingsRow>(
    `SELECT ${SETTINGS_COLS} FROM sim_settings WHERE id = true LIMIT 1`,
  )
  if (rows[0]) return mapSettings(rows[0])
  await query(`INSERT INTO sim_settings (id) VALUES (true) ON CONFLICT DO NOTHING`)
  const again = await query<SettingsRow>(
    `SELECT ${SETTINGS_COLS} FROM sim_settings WHERE id = true LIMIT 1`,
  )
  return mapSettings(again[0])
}

export interface SettingsPatch {
  enabled?: boolean
  channelIds?: string[]
  aggression?: number
  maxThreads?: number
  spawnMinSec?: number
  spawnMaxSec?: number
  replyMinSec?: number
  replyMaxSec?: number
}

/** Partial update of the settings row. Enabling stamps started_at. */
export async function updateSettings(patch: SettingsPatch): Promise<SimSettings> {
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = []
  const push = (col: string, val: unknown) => {
    params.push(val)
    sets.push(`${col} = $${params.length}`)
  }

  if (patch.enabled !== undefined) {
    push('enabled', patch.enabled)
    // Stamp started_at the moment it flips on; keep the schedule primed so the
    // engine can spawn immediately rather than waiting a full cycle.
    if (patch.enabled) sets.push('started_at = now()', 'next_spawn_at = now()')
  }
  if (patch.channelIds !== undefined) push('channel_ids', patch.channelIds)
  if (patch.aggression !== undefined)
    push('aggression', clampInt(patch.aggression, 0, 100))
  if (patch.maxThreads !== undefined)
    push('max_threads', clampInt(patch.maxThreads, 1, 100))
  if (patch.spawnMinSec !== undefined)
    push('spawn_min_sec', clampInt(patch.spawnMinSec, 5, 86_400))
  if (patch.spawnMaxSec !== undefined)
    push('spawn_max_sec', clampInt(patch.spawnMaxSec, 5, 86_400))
  if (patch.replyMinSec !== undefined)
    push('reply_min_sec', clampInt(patch.replyMinSec, 1, 86_400))
  if (patch.replyMaxSec !== undefined)
    push('reply_max_sec', clampInt(patch.replyMaxSec, 1, 86_400))

  await query(`UPDATE sim_settings SET ${sets.join(', ')} WHERE id = true`, params)
  return getSettings()
}

function clampInt(n: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(n) || min, min), max)
}

/**
 * Atomically claim the next spawn slot. Returns true only for the single caller
 * that wins the race (guards against double-spawning across concurrent ticks).
 * On success it also reschedules the next spawn window.
 */
export async function claimSpawnSlot(nextDelaySec: number): Promise<boolean> {
  const rows = await query<{ id: boolean }>(
    `UPDATE sim_settings
        SET next_spawn_at = now() + make_interval(secs => $1::int),
            spawned_total = spawned_total + 1,
            updated_at = now()
      WHERE id = true
        AND enabled = true
        AND (next_spawn_at IS NULL OR next_spawn_at <= now())
      RETURNING id`,
    [Math.max(1, Math.floor(nextDelaySec))],
  )
  return rows.length > 0
}

export async function bumpRepliesTotal(): Promise<void> {
  await query(
    `UPDATE sim_settings SET replies_total = replies_total + 1, updated_at = now() WHERE id = true`,
  )
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
