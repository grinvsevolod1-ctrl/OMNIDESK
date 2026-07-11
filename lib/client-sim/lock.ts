import type { PoolClient } from 'pg'
import { getPool } from '@/lib/db'

/**
 * Single-instance guard for the simulator engine.
 *
 * The engine must drive conversations from exactly ONE process at a time. On a
 * single-process VPS (pm2/systemd/`next start`) that is already the case, but to
 * stay correct if the app is ever run as a cluster or multiple containers we
 * take a PostgreSQL *session-level advisory lock*.
 *
 * Why a dedicated client: `lib/db`'s `query()` borrows a pooled connection and
 * immediately returns it, so a session-level lock taken there would be released
 * right away. We therefore check out one dedicated client from the pool and
 * hold it for the whole time this process owns the engine.
 *
 * Self-healing: an advisory lock is bound to its DB session. If the owning
 * process crashes or the connection drops, PostgreSQL releases the lock
 * automatically, and any other process picks it up on its next tick. No stale
 * locks, no manual cleanup.
 */

// Stable, app-specific lock key. Arbitrary but must never collide with another
// advisory lock in the same database.
const LOCK_KEY = 4021990117

interface LockHandle {
  client: PoolClient | null
  held: boolean
  acquiring: boolean
}

const g = globalThis as unknown as { __clientSimLock?: LockHandle }

function handle(): LockHandle {
  if (!g.__clientSimLock) {
    g.__clientSimLock = { client: null, held: false, acquiring: false }
  }
  return g.__clientSimLock
}

/** True if this process currently owns the engine lock. */
export function lockHeld(): boolean {
  return handle().held
}

function resetClient(h: LockHandle): void {
  h.held = false
  if (h.client) {
    try {
      h.client.release()
    } catch {
      /* already released */
    }
    h.client = null
  }
}

/**
 * Ensure this process holds the advisory lock.
 *
 * - Returns `true` immediately if already held.
 * - Otherwise checks out a dedicated client and attempts a non-blocking
 *   `pg_try_advisory_lock`. Returns whether it won ownership.
 *
 * Safe to call on every tick: it's a cheap flag check once held, and only
 * touches the DB while trying to (re)acquire.
 */
export async function ensureLock(): Promise<boolean> {
  const h = handle()
  if (h.held) return true
  if (h.acquiring) return false // another attempt is in flight
  h.acquiring = true
  try {
    if (!h.client) {
      const client = await getPool().connect()
      // If the dedicated connection ever errors/ends, drop our claim so the
      // next tick reacquires (here or in another process).
      client.on('error', () => resetClient(h))
      client.on('end', () => resetClient(h))
      h.client = client
    }
    const res = await h.client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LOCK_KEY],
    )
    h.held = Boolean(res.rows[0]?.locked)
    if (!h.held) {
      // Someone else owns it. Release the dedicated client back to the pool so
      // we don't hold an idle connection while we're just a standby.
      resetClient(h)
    }
    return h.held
  } catch (err) {
    console.log(
      '[v0][client-sim] lock acquire failed:',
      err instanceof Error ? err.message : String(err),
    )
    resetClient(h)
    return false
  } finally {
    h.acquiring = false
  }
}

/** Release the lock and return the dedicated client to the pool. */
export async function releaseLock(): Promise<void> {
  const h = handle()
  if (h.client && h.held) {
    try {
      await h.client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY])
    } catch {
      /* connection may already be gone; PG frees the lock on session end */
    }
  }
  resetClient(h)
}
