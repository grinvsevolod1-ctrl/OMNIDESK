/**
 * Managers CRUD, auth state and status.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import type { Manager, ManagerStatus } from '../types'
import { excludeAdminSql, toManager, type ManagerRow } from './shared'

/* ----------------------------- Managers ----------------------------- */

export interface ManagerWithSecret extends Manager {
  passwordHash: string
  sessionVersion: number
}

function toManagerWithSecret(row: ManagerRow): ManagerWithSecret {
  return {
    ...toManager(row),
    passwordHash: row.password_hash,
    sessionVersion: row.session_version ?? 0,
  }
}

export async function getManagerByEmail(
  email: string,
): Promise<ManagerWithSecret | null> {
  const normalized = email.trim().toLowerCase()
  const rows = await query<ManagerRow>(
    'SELECT * FROM managers WHERE lower(email) = $1 LIMIT 1',
    [normalized],
  )
  return rows[0] ? toManagerWithSecret(rows[0]) : null
}

/**
 * Sanitize an arbitrary string into a valid login: lowercase, only
 * [a-z0-9._-], everything else stripped. Returns '' when nothing survives so
 * callers can fall back (e.g. to a generated login).
 */
export function sanitizeUsername(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
}

/** Derive a login from an email address (its local-part), sanitized. */
export function usernameFromEmail(email: string): string {
  return sanitizeUsername(email.split('@')[0] ?? '')
}

/**
 * Look up a manager by either their email (identifier contains '@') or their
 * login. Case-insensitive. Used by the login flow so a single field accepts
 * both forms.
 */
export async function getManagerByIdentifier(
  identifier: string,
): Promise<ManagerWithSecret | null> {
  const id = identifier.trim().toLowerCase()
  if (!id) return null
  const byEmail = id.includes('@')
  const rows = await query<ManagerRow>(
    byEmail
      ? 'SELECT * FROM managers WHERE lower(email) = $1 LIMIT 1'
      : 'SELECT * FROM managers WHERE lower(username) = $1 LIMIT 1',
    [id],
  )
  return rows[0] ? toManagerWithSecret(rows[0]) : null
}

/**
 * Resolve a unique login from a desired base, appending -2, -3, … on collision.
 * Falls back to 'user' when the base sanitizes to empty.
 */
async function resolveUniqueUsername(base: string): Promise<string> {
  const clean = sanitizeUsername(base) || 'user'
  const taken = await query<{ username: string }>(
    `SELECT lower(username) AS username FROM managers
      WHERE username IS NOT NULL
        AND (lower(username) = $1 OR lower(username) LIKE $1 || '-%')`,
    [clean],
  )
  const used = new Set(taken.map((r) => r.username))
  if (!used.has(clean)) return clean
  let n = 2
  while (used.has(`${clean}-${n}`)) n++
  return `${clean}-${n}`
}

/**
 * Lightweight auth-state lookup used on every authenticated request to validate
 * a manager's session against the live DB (blocked status + session version).
 * Returns null when the manager no longer exists.
 */
export async function getManagerAuthState(
  id: string,
): Promise<{ status: ManagerStatus; sessionVersion: number } | null> {
  const rows = await query<{
    status: ManagerStatus
    session_version: number
  }>('SELECT status, session_version FROM managers WHERE id = $1 LIMIT 1', [id])
  if (!rows[0]) return null
  return {
    status: rows[0].status,
    sessionVersion: rows[0].session_version ?? 0,
  }
}

export async function getManagerById(id: string): Promise<Manager | null> {
  const rows = await query<ManagerRow>(
    'SELECT * FROM managers WHERE id = $1 LIMIT 1',
    [id],
  )
  return rows[0] ? toManager(rows[0]) : null
}

export async function listManagers(): Promise<Manager[]> {
  // Exclude the env-backed administrator: it is not a real manager and must
  // never appear in the managers pool (assignment, transfer, blocking, etc.).
  const rows = await query<ManagerRow>(
    `SELECT * FROM managers
      WHERE true ${excludeAdminSql('managers')}
      ORDER BY created_at DESC`,
  )
  return rows.map(toManager)
}

export async function createManager(input: {
  name: string
  email: string
  passwordHash: string
  /** Optional custom login; defaults to the email local-part when omitted. */
  username?: string
}): Promise<Manager> {
  const id = randomUUID()
  const email = input.email.trim().toLowerCase()
  const desired = input.username?.trim()
    ? input.username
    : usernameFromEmail(email)
  const username = await resolveUniqueUsername(desired)
  const rows = await query<ManagerRow>(
    `INSERT INTO managers (id, name, email, username, password_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'active') RETURNING *`,
    [id, input.name.trim(), email, username, input.passwordHash],
  )
  return toManager(rows[0])
}

export async function updateManagerStatus(
  id: string,
  status: ManagerStatus,
): Promise<void> {
  // Blocking a manager must also revoke their live sessions immediately, so
  // bump session_version when (and only when) they are being blocked.
  await query(
    `UPDATE managers
        SET status = $2,
            session_version = session_version + CASE WHEN $2 = 'blocked' THEN 1 ELSE 0 END
      WHERE id = $1`,
    [id, status],
  )
}

export async function updateManagerPassword(
  id: string,
  passwordHash: string,
): Promise<void> {
  // Any password change invalidates all outstanding sessions for this manager
  // by advancing session_version. The session that initiated a self-service
  // change must re-issue its cookie afterwards (see changeOwnPasswordAction).
  await query(
    'UPDATE managers SET password_hash = $2, session_version = session_version + 1 WHERE id = $1',
    [id, passwordHash],
  )
}

export async function deleteManager(id: string): Promise<void> {
  // Telegram/WhatsApp channels are bound to this manager's worker session, so
  // they should still go away with the manager. After migration 008 the FK is
  // ON DELETE SET NULL (to protect live-chat), so we remove them explicitly to
  // preserve the previous behaviour for these worker-backed channels.
  await query(
    `DELETE FROM channels WHERE manager_id = $1 AND type <> 'livechat'`,
    [id],
  )
  // Live-chat channels are standalone resources and must SURVIVE manager
  // deletion. Strip this manager's id out of every live-chat round-robin pool
  // so routing never points at a ghost manager. The channels.manager_id FK
  // (ON DELETE SET NULL) keeps the channel itself; it simply shows "no agents
  // available" in the widget until a manager is assigned again.
  await query(
    `UPDATE channels
        SET config = jsonb_set(
              COALESCE(config, '{}'::jsonb),
              '{pool}',
              COALESCE(
                (
                  SELECT jsonb_agg(p)
                  FROM jsonb_array_elements_text(config->'pool') AS p
                  WHERE p <> $1
                ),
                '[]'::jsonb
              )
            )
      WHERE type = 'livechat'
        AND config->'pool' IS NOT NULL`,
    [id],
  )
  // Finally remove the manager. Their own conversations cascade away; live-chat
  // channels they owned have manager_id set to NULL by the FK.
  await query('DELETE FROM managers WHERE id = $1', [id])
}

