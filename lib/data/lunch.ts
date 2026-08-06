/**
 * Manager lunch / availability: on-lunch flag, available-manager count and
 * lunch substitution routing.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 *
 * All availability queries filter role = 'manager' so curators (who share the
 * managers table) never inflate the online pool or receive substituted dialogs.
 */
import { query, withTransaction } from '../db'
import { nextRoundRobinIndex } from './shared'

/* --------------------------- Lunch / availability -------------------------- */

/** Named round-robin counter used to spread substituted conversations. */
const LUNCH_RR_COUNTER = 'lunch_substitute'

/**
 * Advisory-lock key serializing all "go on lunch" attempts. Arbitrary but
 * stable app-wide constant (never reused for another lock).
 */
const LUNCH_LOCK_KEY = 48_291_034

/** Set/clear the calling manager's "on lunch" availability flag. */
export async function setManagerOnLunch(
  managerId: string,
  onLunch: boolean,
): Promise<void> {
  await query(
    `UPDATE managers SET on_lunch = $2 WHERE id = $1 AND role = 'manager'`,
    [managerId, onLunch],
  )
}

/**
 * Atomically try to put a manager on lunch, guaranteeing at least one active
 * manager always stays available.
 *
 * The old flow was check-then-set in two separate queries with no locking — a
 * textbook TOCTOU race. Lunch is exactly the worst case for it: everyone
 * presses the button at the same minute, every request sees the OTHERS as
 * still available, all pass the check, and the whole team walks out at once.
 *
 * Fix: one transaction holding a Postgres advisory lock, so concurrent
 * attempts run strictly one-by-one — the last available manager is always
 * caught, no matter how simultaneous the clicks are. Fails CLOSED: if the
 * availability check errors we refuse the lunch (never strand the line
 * unmanned); going OFF lunch stays unguarded via setManagerOnLunch.
 *
 * Returns true when the manager is now on lunch, false when they are the last
 * one available and must stay.
 */
export async function tryGoOnLunch(managerId: string): Promise<boolean> {
  return withTransaction(async (db) => {
    // Serialize all go-on-lunch attempts (auto-released at COMMIT/ROLLBACK).
    await db.query('SELECT pg_advisory_xact_lock($1)', [LUNCH_LOCK_KEY])
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM managers
        WHERE role = 'manager'
          AND status = 'active'
          AND on_lunch = false
          AND id <> $1::uuid`,
      [managerId],
    )
    if (Number(rows[0]?.n ?? 0) < 1) return false
    await db.query(
      `UPDATE managers SET on_lunch = true WHERE id = $1 AND role = 'manager'`,
      [managerId],
    )
    return true
  })
}

/**
 * Count managers currently AVAILABLE to take new conversations: active and not
 * on lunch. Used to guarantee at least one manager always stays online — the
 * last available manager can't go on lunch. Curators are excluded.
 */
export async function countAvailableManagers(): Promise<number> {
  try {
    const rows = await query<{ n: string | number }>(
      `SELECT count(*)::int AS n FROM managers
        WHERE role = 'manager' AND status = 'active' AND on_lunch = false`,
    )
    return Number(rows[0]?.n ?? 0)
  } catch (err) {
    console.error('countAvailableManagers failed (migration 034?):', err)
    // Fail open: if we can't count, don't trap a manager off-lunch.
    return 99
  }
}

/** Read a single manager's current "on lunch" flag (false if not found). */
export async function getManagerOnLunch(managerId: string): Promise<boolean> {
  try {
    const rows = await query<{ on_lunch: boolean }>(
      'SELECT on_lunch FROM managers WHERE id = $1 LIMIT 1',
      [managerId],
    )
    return rows[0]?.on_lunch ?? false
  } catch (err) {
    // Tolerate the column not existing yet (migration 034 not applied) so the
    // panel keeps working until the DB is migrated.
    console.error('getManagerOnLunch failed (migration 034?):', err)
    return false
  }
}

/**
 * Decide who should HANDLE a brand-new conversation, accounting for lunch
 * breaks. If the natural owner (`ownerId`) is active and not on lunch, they
 * keep it. Otherwise we round-robin across all OTHER active managers who are
 * available right now, so the customer isn't left waiting. When nobody else is
 * free we fall back to the owner (better a delayed reply than a dropped one).
 *
 * Only affects NEW conversations — existing ones are never reassigned, so a
 * manager returning from lunch keeps whatever the substitute already picked up.
 *
 * Safe to call from both ingest paths (app-side webhooks and the worker).
 * Curators are never selected as substitutes.
 */
export async function applyLunchSubstitution(
  ownerId: string | null,
): Promise<string | null> {
  if (!ownerId) return ownerId

  try {
    // Is the natural owner available? (exists, active manager, not on lunch)
    const ownerRows = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE id = $1
          AND role = 'manager'
          AND status = 'active'
          AND on_lunch = false
        LIMIT 1`,
      [ownerId],
    )
    if (ownerRows[0]) return ownerId

    // Owner is away — gather available substitutes (active managers, not on
    // lunch, not the owner), ordered deterministically so the RR cursor is stable.
    const subs = await query<{ id: string }>(
      `SELECT id FROM managers
        WHERE role = 'manager'
          AND status = 'active'
          AND on_lunch = false
          AND id <> $1::uuid
        ORDER BY id ASC`,
      [ownerId],
    )
    if (subs.length === 0) return ownerId // nobody free — owner keeps it
    if (subs.length === 1) return subs[0].id

    const idx = await nextRoundRobinIndex(LUNCH_RR_COUNTER)
    return subs[idx % subs.length].id
  } catch (err) {
    // If the on_lunch column isn't there yet (migration 034 not applied), keep
    // the owner so inbound routing never breaks.
    console.error('applyLunchSubstitution failed (migration 034?):', err)
    return ownerId
  }
}

/**
 * Resolve a live-chat channel by its public API key. Used by the website widget
 * endpoints (ingest + stream) which authenticate with the key, not a session.
 */
