/**
 * Audit log — append-only accountability trail for admin/manager/curator
 * actions (logins, lead transfers, AI-settings changes, account management).
 *
 * Fire-and-forget by design: `writeAudit` swallows its own failures after
 * logging them, so an audit hiccup can never break the business action it
 * records. Do NOT await-and-throw around it.
 *
 * ISOLATION INVARIANT (AGENTS.md section 4): no god-panel code path may ever
 * import this module or otherwise produce audit rows. The audit log is
 * visible to the admin — a single row would leak the panel's existence.
 */
import { query } from '../db'

export type AuditActorRole = 'admin' | 'manager' | 'curator' | 'head'

export interface AuditEntry {
  actorRole: AuditActorRole
  /** managers.id for manager/curator; null for the env-backed admin. */
  actorId?: string | null
  /** Human-readable label frozen at write time (e.g. "Иван (менеджер)"). */
  actorLabel: string
  /** Machine key, e.g. 'auth.login', 'lead.transfer', 'ai.settings.update'. */
  action: string
  entityType?: string | null
  entityId?: string | null
  /** Small JSON details. Never secrets, never full message bodies. */
  details?: Record<string, unknown>
}

/** Insert one audit row. Never throws — failures are logged and swallowed. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log
         (actor_role, actor_id, actor_label, action, entity_type, entity_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        entry.actorRole,
        entry.actorId ?? null,
        entry.actorLabel,
        entry.action,
        entry.entityType ?? null,
        entry.entityId ?? null,
        JSON.stringify(entry.details ?? {}),
      ],
    )
  } catch (err) {
    console.error('[audit] write failed:', err)
  }
}

export interface AuditRow {
  id: string
  createdAt: string
  actorRole: AuditActorRole
  actorId: string | null
  actorLabel: string
  action: string
  entityType: string | null
  entityId: string | null
  details: Record<string, unknown>
}

export interface AuditPage {
  rows: AuditRow[]
  total: number
}

export interface LoginEvent {
  id: string
  createdAt: string
  ip: string | null
  /** Browser/device from the User-Agent header (truncated at write time). */
  userAgent: string | null
  /** Which second factor confirmed this login, if any. */
  twofa: 'totp' | 'telegram' | null
  /** True when a one-time backup code was used instead of a live code. */
  backupCode: boolean
  /** True when the login used a temporary (god-panel issued) password. */
  tempPassword: boolean
}

/**
 * Self-service reader for the staff "Сессии" tab: the employee's own recent
 * logins, newest first. Master-override logins (admin password into this
 * account) AND temporary-password logins (god-panel issued) are deliberately
 * EXCLUDED — both are admin entries into the account, and the same secrecy
 * rule applies as in the admin-visible audit list (AGENTS.md): the employee
 * must not see or be notified about them.
 */
export async function listMyLogins(
  actorId: string,
  limit = 20,
): Promise<LoginEvent[]> {
  const rows = await query<{
    id: string
    created_at: string
    details: Record<string, unknown>
  }>(
    `SELECT id, created_at, details
       FROM audit_log
      WHERE actor_id = $1
        AND action = 'auth.login'
        AND COALESCE((details->>'master')::boolean, false) = false
        AND COALESCE((details->>'temp')::boolean, false) = false
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [actorId, Math.min(Math.max(1, limit), 100)],
  )
  return rows.map((r) => {
    const d = r.details ?? {}
    const twofa = d.twofa === 'totp' || d.twofa === 'telegram' ? d.twofa : null
    return {
      id: r.id,
      createdAt:
        typeof r.created_at === 'string'
          ? r.created_at
          : new Date(r.created_at).toISOString(),
      ip: typeof d.ip === 'string' && d.ip ? d.ip : null,
      userAgent: typeof d.ua === 'string' && d.ua ? d.ua : null,
      twofa,
      backupCode: d.backup === true,
      tempPassword: d.temp === true,
    }
  })
}

/** Admin-only reader: newest first, optional action-prefix filter. */
export async function listAudit(opts: {
  limit: number
  offset: number
  /** e.g. 'auth.' to see only auth events; matched as a prefix. */
  actionPrefix?: string
}): Promise<AuditPage> {
  const limit = Math.min(Math.max(1, opts.limit), 200)
  const offset = Math.max(0, opts.offset)
  const prefix = (opts.actionPrefix ?? '').trim()

  const where = prefix ? `WHERE action LIKE $3 || '%'` : ''
  const params: unknown[] = [limit, offset]
  if (prefix) params.push(prefix)

  const [rowsRes, countRes] = await Promise.all([
    query<{
      id: string
      created_at: string
      actor_role: AuditActorRole
      actor_id: string | null
      actor_label: string
      action: string
      entity_type: string | null
      entity_id: string | null
      details: Record<string, unknown>
    }>(
      `SELECT id, created_at, actor_role, actor_id, actor_label, action,
              entity_type, entity_id, details
         FROM audit_log ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2`,
      params,
    ),
    query<{ n: string }>(
      prefix
        ? `SELECT count(*)::text AS n FROM audit_log WHERE action LIKE $1 || '%'`
        : `SELECT count(*)::text AS n FROM audit_log`,
      prefix ? [prefix] : [],
    ),
  ])

  return {
    rows: rowsRes.map((r) => ({
      id: r.id,
      createdAt:
        typeof r.created_at === 'string'
          ? r.created_at
          : new Date(r.created_at).toISOString(),
      actorRole: r.actor_role,
      actorId: r.actor_id,
      actorLabel: r.actor_label,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      details: r.details ?? {},
    })),
    total: Number(countRes[0]?.n ?? 0),
  }
}
