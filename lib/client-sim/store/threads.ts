/**
 * Client-sim threads: lifecycle queries, due/reaction scheduling, nudges, pause and per-thread sim info.
 */

import {
  query,
} from '@/lib/db'
import {
  type SimOutcome,
  type SimPersona,
  type SimState,
  type SimThreadRow,
} from '../types'
import {
  hasThreadPauseCol,
  hasThreadRealismCols,
  mapThread,
  readPersonaName,
  type ThreadRow,
} from './internal'

/* ------------------------------- threads -------------------------------- */

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
  // Skip dialogues an operator has stepped into (paused) so the simulator stays
  // detached from just those threads. No-op filter on a pre-073 DB.
  const hasPause = await hasThreadPauseCol()
  const pauseClause = hasPause ? 'AND paused = false' : ''
  const pauseRet = hasPause ? ', paused' : ''
  const rows = await query<ThreadRow>(
    `UPDATE sim_threads t
        SET next_run_at = now() + interval '2 minutes', updated_at = now()
      WHERE t.conversation_id IN (
        SELECT conversation_id FROM sim_threads
         WHERE state <> 'done'
           AND next_run_at IS NOT NULL
           AND next_run_at <= now()
           ${pauseClause}
         ORDER BY next_run_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING conversation_id, channel_id, persona, state, turns, last_seen_out, next_run_at${pauseRet}`,
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
  // Don't react in dialogues an operator has taken over (paused). No-op on pre-073 DB.
  const hasPause = await hasThreadPauseCol()
  const pauseClause = hasPause ? 'AND t.paused = false' : ''
  const pauseSel = hasPause ? ', t.paused' : ''
  const rows = await query<
    ThreadRow & { m_id: string; m_body: string }
  >(
    `SELECT t.conversation_id, t.channel_id, t.persona, t.state, t.turns,
            t.last_seen_out, t.next_run_at${pauseSel},
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
        ${pauseClause}
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
  /** Persona JSONB — used to gate human "impatience" pokes by temperament. */
  persona: SimPersona
  /** How many times we've already nudged the manager for this dialogue. */
  nudgeAttempts: number
  /** Seconds since the client's last (unanswered) message. */
  waitedSeconds: number
}

export async function findConversationsAwaitingManager(
  limit: number,
  staleSeconds = 90,
): Promise<StuckConversation[]> {
  // Per-conversation backoff: once 061 is applied, skip a dialogue until its
  // nudge_next_at arrives so a manager that never answers (e.g. master switch
  // off) isn't poked every tick forever.
  const hasRealism = await hasThreadRealismCols()
  const backoffClause = hasRealism
    ? 'AND (t.nudge_next_at IS NULL OR t.nudge_next_at <= now())'
    : ''
  const attemptsSel = hasRealism ? 't.nudge_attempts' : '0'
  // Skip dialogues the operator has taken over (paused). No-op on pre-073 DB.
  const pauseClause = (await hasThreadPauseCol()) ? 'AND t.paused = false' : ''
  const rows = await query<{
    conversation_id: string
    body: string
    persona: SimPersona
    nudge_attempts: number
    waited_seconds: number
  }>(
    `SELECT t.conversation_id, m.body, t.persona,
            ${attemptsSel} AS nudge_attempts,
            EXTRACT(EPOCH FROM (now() - m.created_at))::int AS waited_seconds
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
        ${pauseClause}
      ORDER BY t.updated_at ASC
      LIMIT $1`,
    [Math.max(1, limit), Math.max(0, Math.floor(staleSeconds))],
  )
  return rows.map((r) => ({
    conversationId: r.conversation_id,
    lastClientBody: r.body,
    persona: r.persona,
    nudgeAttempts: r.nudge_attempts ?? 0,
    waitedSeconds: r.waited_seconds ?? 0,
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

/**
 * Per-conversation pause switch used when an operator steps into a single
 * simulated dialogue from the god console.
 *
 *   paused = true  → detach the simulator from THIS dialogue only. The
 *                    scheduler/reaction/backlog sweeps skip it; every other
 *                    live thread keeps running untouched.
 *   paused = false → re-attach. We re-arm next_run_at = now() so on the next
 *                    tick the engine re-reads the WHOLE transcript (including
 *                    the operator's manual client-side lines) and continues in
 *                    the same persona — no explicit re-analysis step needed.
 *
 * No-op (returns false) on a DB that hasn't applied migration 073 yet.
 * Returns true when a row was actually updated.
 */
export async function setThreadPaused(
  conversationId: string,
  paused: boolean,
): Promise<boolean> {
  if (!(await hasThreadPauseCol())) return false
  const setClause = paused
    ? `paused = true, paused_at = now(), updated_at = now()`
    : `paused = false, paused_at = NULL, next_run_at = now(), updated_at = now()`
  const rows = await query<{ conversation_id: string }>(
    `UPDATE sim_threads
        SET ${setClause}
      WHERE conversation_id = $1
        AND state <> 'done'
      RETURNING conversation_id`,
    [conversationId],
  )
  return rows.length > 0
}

/** Lightweight simulator-involvement snapshot for one conversation. */
export interface ThreadSimInfo {
  /** A live (non-done) simulator thread drives this conversation. */
  active: boolean
  /** Operator has stepped in, so the simulator is detached from this one. */
  paused: boolean
  state: SimState
  /** Persona display name, when available. */
  personaName: string | null
}

/**
 * Bulk-fetch simulator involvement for a set of conversations, for the god
 * console list. Returns a Map keyed by conversationId; conversations with no
 * sim thread simply won't have an entry (caller treats them as "not simulated").
 * Safe on a pre-073 DB — the `paused` column degrades to false.
 */
export async function getThreadsSimInfo(
  conversationIds: string[],
): Promise<Map<string, ThreadSimInfo>> {
  const out = new Map<string, ThreadSimInfo>()
  if (conversationIds.length === 0) return out
  const hasPause = await hasThreadPauseCol()
  const pausedSel = hasPause ? 'paused' : 'false AS paused'
  const rows = await query<{
    conversation_id: string
    state: SimState
    paused: boolean
    persona: unknown
  }>(
    `SELECT conversation_id, state, ${pausedSel}, persona
       FROM sim_threads
      WHERE conversation_id = ANY($1)`,
    [conversationIds],
  )
  for (const r of rows) {
    out.set(r.conversation_id, {
      active: r.state !== 'done',
      paused: r.paused ?? false,
      state: r.state,
      personaName: readPersonaName(r.persona),
    })
  }
  return out
}

/** Single-conversation variant of {@link getThreadsSimInfo}. */
export async function getThreadSimInfoOne(
  conversationId: string,
): Promise<ThreadSimInfo | null> {
  const map = await getThreadsSimInfo([conversationId])
  return map.get(conversationId) ?? null
}

/** Mark that we've seen a manager message and schedule a delayed reaction. */
export async function scheduleReaction(
  conversationId: string,
  managerMessageId: string,
  delaySec: number,
): Promise<void> {
  // The manager replied → real progress. Clear nudge backoff (post-061) so a
  // future stall is treated fresh instead of staying muted.
  const resetBackoff = (await hasThreadRealismCols())
    ? ', nudge_attempts = 0, nudge_next_at = NULL'
    : ''
  await query(
    `UPDATE sim_threads
        SET last_seen_out = $2,
            next_run_at = now() + make_interval(secs => $3::int),
            updated_at = now()${resetBackoff}
      WHERE conversation_id = $1`,
    [conversationId, managerMessageId, Math.max(1, Math.floor(delaySec))],
  )
}

/** Persist a thread's new state / schedule after the engine acts on it. */
export async function updateThread(
  conversationId: string,
  patch: {
    state?: SimState
    turns?: number
    nextRunAt?: string | null
    outcome?: SimOutcome | null
  },
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
  // `outcome` only exists post-061; guard so a lagging DB doesn't error.
  if (patch.outcome !== undefined && (await hasThreadRealismCols())) {
    params.push(patch.outcome)
    sets.push(`outcome = $${params.length}`)
  }
  await query(`UPDATE sim_threads SET ${sets.join(', ')} WHERE conversation_id = $1`, params)
}
