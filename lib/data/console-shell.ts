import 'server-only'
import { query } from '@/lib/db'
import type { AssistantTurn } from '@/lib/admin-console/assistant'

/**
 * OS shell persistence: dialog memory + scheduled commands.
 * Backed by scripts/100_os_shell_memory.sql.
 */

/* --------------------------- dialog memory --------------------------- */

/** How many turns survive a reload (matches the model context budget). */
const SESSION_TURNS_LIMIT = 24

/**
 * Load the saved dialog for this admin identity ([] when none).
 *
 * FAIL-OPEN: called from the admin layout on every /admin load. Before the
 * migration runs (or during a DB hiccup) this must degrade to "no memory",
 * never to a 500 for the whole admin panel.
 */
export async function loadConsoleSession(
  userId: string,
): Promise<AssistantTurn[]> {
  try {
    const rows = await query<{ turns: unknown }>(
      `SELECT turns FROM console_sessions WHERE user_id = $1`,
      [userId],
    )
    const raw = rows[0]?.turns
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (t): t is AssistantTurn =>
          !!t &&
          typeof t === 'object' &&
          ((t as AssistantTurn).role === 'user' ||
            (t as AssistantTurn).role === 'assistant') &&
          typeof (t as AssistantTurn).content === 'string',
      )
      .slice(-SESSION_TURNS_LIMIT)
  } catch {
    return []
  }
}

/** Persist the dialog (trimmed). Upsert keeps exactly one row per admin. */
export async function saveConsoleSession(
  userId: string,
  turns: AssistantTurn[],
): Promise<void> {
  const trimmed = turns.slice(-SESSION_TURNS_LIMIT)
  await query(
    `INSERT INTO console_sessions (user_id, turns, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
       SET turns = EXCLUDED.turns, updated_at = now()`,
    [userId, JSON.stringify(trimmed)],
  )
}

/** Forget the dialog ("новый диалог"). */
export async function clearConsoleSession(userId: string): Promise<void> {
  await query(`DELETE FROM console_sessions WHERE user_id = $1`, [userId])
}

/* --------------------------- dialog history -------------------------- */

/** How many archived dialogs are kept per admin (oldest pruned). */
const ARCHIVE_KEEP = 30

export interface ConsoleSessionArchiveItem {
  id: string
  title: string
  turnCount: number
  createdAt: string
}

/**
 * Archive the CURRENT dialog (if non-trivial) so «Новый диалог» is reversible.
 * Title = first user utterance. Prunes beyond ARCHIVE_KEEP. Fail-open: history
 * is a nicety, an archive failure must never block starting a new dialog.
 */
export async function archiveConsoleSession(userId: string): Promise<void> {
  try {
    const turns = await loadConsoleSession(userId)
    const firstUser = turns.find((t) => t.role === 'user')?.content?.trim()
    // Nothing worth keeping: no user utterance ever happened.
    if (!firstUser) return
    const title = firstUser.length > 80 ? `${firstUser.slice(0, 79)}…` : firstUser
    await query(
      `INSERT INTO console_session_archive (user_id, title, turns)
       VALUES ($1, $2, $3::jsonb)`,
      [userId, title, JSON.stringify(turns)],
    )
    await query(
      `DELETE FROM console_session_archive
        WHERE user_id = $1
          AND id NOT IN (
            SELECT id FROM console_session_archive
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT ${ARCHIVE_KEEP}
          )`,
      [userId],
    )
  } catch {
    // Pre-migration or DB hiccup — degrade to the old destructive behavior.
  }
}

/** Archived dialogs, newest first (fail-open: [] before the migration). */
export async function listConsoleSessionArchive(
  userId: string,
): Promise<ConsoleSessionArchiveItem[]> {
  try {
    const rows = await query<{
      id: string
      title: string
      turn_count: number | string
      created_at: string
    }>(
      `SELECT id, title, jsonb_array_length(turns) AS turn_count, created_at
         FROM console_session_archive
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT ${ARCHIVE_KEEP}`,
      [userId],
    )
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      turnCount: Number(r.turn_count),
      createdAt: r.created_at,
    }))
  } catch {
    return []
  }
}

/**
 * Restore an archived dialog as the live session. The archive row is consumed
 * (it becomes the live dialog again); the current dialog is archived first so
 * nothing is ever lost. Returns the restored turns, or null if not found.
 */
export async function restoreConsoleSession(
  userId: string,
  archiveId: string,
): Promise<AssistantTurn[] | null> {
  const rows = await query<{ turns: unknown }>(
    `SELECT turns FROM console_session_archive
      WHERE id = $2 AND user_id = $1`,
    [userId, archiveId],
  )
  const raw = rows[0]?.turns
  if (!Array.isArray(raw)) return null
  const turns = raw.filter(
    (t): t is AssistantTurn =>
      !!t &&
      typeof t === 'object' &&
      ((t as AssistantTurn).role === 'user' ||
        (t as AssistantTurn).role === 'assistant') &&
      typeof (t as AssistantTurn).content === 'string',
  )
  await archiveConsoleSession(userId)
  await saveConsoleSession(userId, turns)
  await query(
    `DELETE FROM console_session_archive WHERE id = $2 AND user_id = $1`,
    [userId, archiveId],
  )
  return turns.slice(-SESSION_TURNS_LIMIT)
}

/* ------------------------- scheduled commands ------------------------ */

export type ConsoleScheduleKind =
  | 'hourly'
  | 'daily'
  | `weekly:${1 | 2 | 3 | 4 | 5 | 6 | 7}`

export interface ConsoleSchedule {
  id: string
  userId: string
  label: string
  prompt: string
  schedule: string
  runMinute: number
  enabled: boolean
  nextRunAt: string
  lastRunAt: string | null
  lastResult: string | null
  createdAt: string
}

interface ScheduleRow {
  id: string
  user_id: string
  label: string
  prompt: string
  schedule: string
  run_minute: number
  enabled: boolean
  next_run_at: string
  last_run_at: string | null
  last_result: string | null
  created_at: string
}

function mapSchedule(r: ScheduleRow): ConsoleSchedule {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    prompt: r.prompt,
    schedule: r.schedule,
    runMinute: r.run_minute,
    enabled: r.enabled,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastResult: r.last_result,
    createdAt: r.created_at,
  }
}

/**
 * Next execution time for a schedule, strictly after `from`.
 * weekly uses ISO weekday (1 = Monday). Times are server-local — the same
 * clock the rest of the cron infrastructure uses.
 */
export function computeNextRun(
  schedule: string,
  runMinute: number,
  from: Date = new Date(),
): Date {
  const next = new Date(from)
  if (schedule === 'hourly') {
    next.setMinutes(0, 0, 0)
    next.setHours(next.getHours() + 1)
    return next
  }
  const hours = Math.floor(runMinute / 60)
  const minutes = runMinute % 60
  next.setHours(hours, minutes, 0, 0)
  if (schedule === 'daily') {
    if (next <= from) next.setDate(next.getDate() + 1)
    return next
  }
  const weekday = Number.parseInt(schedule.split(':')[1] ?? '1', 10)
  const target = Math.min(Math.max(weekday, 1), 7)
  // JS getDay(): 0 = Sunday ... convert to ISO (1 = Monday, 7 = Sunday).
  const isoNow = next.getDay() === 0 ? 7 : next.getDay()
  let diff = target - isoNow
  if (diff < 0 || (diff === 0 && next <= from)) diff += 7
  next.setDate(next.getDate() + diff)
  return next
}

export async function listConsoleSchedules(
  userId: string,
): Promise<ConsoleSchedule[]> {
  const rows = await query<ScheduleRow>(
    `SELECT id, user_id, label, prompt, schedule, run_minute, enabled,
            next_run_at, last_run_at, last_result, created_at
       FROM console_schedules WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  )
  return rows.map(mapSchedule)
}

export async function createConsoleSchedule(input: {
  userId: string
  label: string
  prompt: string
  schedule: string
  runMinute: number
}): Promise<ConsoleSchedule> {
  const nextRun = computeNextRun(input.schedule, input.runMinute)
  const rows = await query<ScheduleRow>(
    `INSERT INTO console_schedules (user_id, label, prompt, schedule, run_minute, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.userId,
      input.label,
      input.prompt,
      input.schedule,
      input.runMinute,
      nextRun.toISOString(),
    ],
  )
  return mapSchedule(rows[0])
}

export async function setConsoleScheduleEnabled(
  userId: string,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE console_schedules SET enabled = $3
     WHERE id = $2 AND user_id = $1 RETURNING id`,
    [userId, id, enabled],
  )
  return rows.length > 0
}

export async function deleteConsoleSchedule(
  userId: string,
  id: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM console_schedules WHERE id = $2 AND user_id = $1 RETURNING id`,
    [userId, id],
  )
  return rows.length > 0
}

/** Due schedules for the cron runner (locked by immediate next_run bump). */
export async function claimDueConsoleSchedules(
  limit: number,
): Promise<ConsoleSchedule[]> {
  // Claim atomically: bump next_run_at FIRST so overlapping cron ticks never
  // run the same schedule twice. The claimed rows are returned as they were.
  const rows = await query<ScheduleRow>(
    `UPDATE console_schedules c
     SET next_run_at = now() + interval '1 hour'
     WHERE c.id IN (
       SELECT id FROM console_schedules
       WHERE enabled AND next_run_at <= now()
       ORDER BY next_run_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING c.*`,
    [limit],
  )
  return rows.map(mapSchedule)
}

/** Record the run and set the real next occurrence. */
export async function recordConsoleScheduleRun(
  id: string,
  result: string,
  schedule: string,
  runMinute: number,
): Promise<void> {
  const nextRun = computeNextRun(schedule, runMinute)
  await query(
    `UPDATE console_schedules
     SET last_run_at = now(), last_result = $2, next_run_at = $3
     WHERE id = $1`,
    [id, result.slice(0, 4000), nextRun.toISOString()],
  )
}
