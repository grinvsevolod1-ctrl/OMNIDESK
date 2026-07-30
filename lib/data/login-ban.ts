import { query } from '../db'

/**
 * Persistent brute-force blocklist for login (scripts/076_login_bans.sql).
 *
 * This is the durable second layer behind the in-memory rate limiter. The
 * in-memory limiter stays the fast synchronous first check; these helpers add a
 * DB-backed ban that survives `pm2 restart`/redeploys, so an attacker cannot
 * reset their attempt budget by waiting for a deploy. Used ONLY on the login
 * path, which is already async and not latency-sensitive.
 *
 * All functions are best-effort and swallow their own errors: a failure in the
 * durable layer must never lock out a legitimate user or crash login — the
 * in-memory limiter still applies.
 */

// Escalating ban durations by strike count (minutes). The Nth trip uses
// BAN_STEPS_MIN[min(N-1, last)] so repeat offenders are held progressively
// longer, capping at the final entry.
const BAN_STEPS_MIN = [5, 15, 60, 360, 1440] // 5m, 15m, 1h, 6h, 24h

export interface LoginBanStatus {
  banned: boolean
  /** Seconds until the ban lifts (0 when not banned). */
  retryAfterSec: number
}

/**
 * Is any of the given keys currently banned? Returns the longest remaining
 * block across them. Never throws — on error it reports "not banned" so the
 * in-memory limiter remains the sole gate.
 */
export async function checkLoginBan(keys: string[]): Promise<LoginBanStatus> {
  if (keys.length === 0) return { banned: false, retryAfterSec: 0 }
  try {
    const rows = await query<{ retry_after_sec: number }>(
      `SELECT EXTRACT(EPOCH FROM (blocked_until - now()))::int AS retry_after_sec
         FROM login_bans
        WHERE key = ANY($1) AND blocked_until > now()
        ORDER BY blocked_until DESC
        LIMIT 1`,
      [keys],
    )
    const retry = rows[0]?.retry_after_sec ?? 0
    return retry > 0
      ? { banned: true, retryAfterSec: retry }
      : { banned: false, retryAfterSec: 0 }
  } catch (err) {
    console.error(
      '[login-ban] checkLoginBan failed (fail-open):',
      err instanceof Error ? err.message : String(err),
    )
    return { banned: false, retryAfterSec: 0 }
  }
}

/**
 * Record a strike against a key and (re)arm its ban with escalating backoff.
 * Called when the in-memory limiter trips. Best-effort; swallows errors.
 */
export async function recordLoginBan(key: string): Promise<void> {
  try {
    // Upsert: increment strikes, then set blocked_until from the strike count.
    // The duration is chosen in SQL so the strike count and window stay
    // consistent under concurrent attempts.
    await query(
      `INSERT INTO login_bans (key, strikes, blocked_until)
         VALUES ($1, 1, now() + ($2::int * interval '1 minute'))
       ON CONFLICT (key) DO UPDATE
         SET strikes = login_bans.strikes + 1,
             blocked_until = now()
               + (($3::int[])[LEAST(login_bans.strikes + 1, $4)] * interval '1 minute'),
             updated_at = now()`,
      [key, BAN_STEPS_MIN[0], BAN_STEPS_MIN, BAN_STEPS_MIN.length],
    )
  } catch (err) {
    console.error(
      '[login-ban] recordLoginBan failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Clear bans for the given keys after a successful login, so a legitimate user
 * who tripped the limiter isn't held once they prove they know the password.
 */
export async function clearLoginBans(keys: string[]): Promise<void> {
  if (keys.length === 0) return
  try {
    await query(`DELETE FROM login_bans WHERE key = ANY($1)`, [keys])
  } catch (err) {
    console.error(
      '[login-ban] clearLoginBans failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** Drop expired ban rows. Cheap housekeeping; call from a periodic job. */
export async function pruneLoginBans(): Promise<number> {
  try {
    const rows = await query<{ id: string }>(
      `DELETE FROM login_bans WHERE blocked_until <= now() RETURNING key AS id`,
    )
    return rows.length
  } catch (err) {
    console.error(
      '[login-ban] pruneLoginBans failed:',
      err instanceof Error ? err.message : String(err),
    )
    return 0
  }
}
