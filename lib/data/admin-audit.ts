import { query } from '../db'

/**
 * Data access for the admin audit trail (scripts/068_admin_audit_log.sql).
 *
 * recordAdminAction is intentionally best-effort and never throws: an audit
 * write failing must not break the privileged operation it accompanies (which
 * has already, or is about to, succeed). Failures are logged and swallowed.
 */

export interface AdminAuditActor {
  id: string
  name: string
}

export interface AdminAuditEntry {
  id: string
  createdAt: string
  actorId: string
  actorName: string
  action: string
  targetId: string | null
  summary: string
  detail: Record<string, unknown> | null
}

/** Append an audit entry. Best-effort: swallows and logs its own errors. */
export async function recordAdminAction(input: {
  actor: AdminAuditActor
  action: string
  targetId?: string | null
  summary?: string
  detail?: Record<string, unknown> | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO admin_audit_log
         (actor_id, actor_name, action, target_id, summary, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.actor.id,
        input.actor.name,
        input.action,
        input.targetId ?? null,
        input.summary ?? '',
        input.detail ? JSON.stringify(input.detail) : null,
      ],
    )
  } catch (err) {
    console.error(
      '[admin-audit] failed to record action:',
      input.action,
      err instanceof Error ? err.message : String(err),
    )
  }
}

/** Most recent audit entries, newest first. */
export async function listAdminAudit(limit = 200): Promise<AdminAuditEntry[]> {
  const capped = Math.min(Math.max(Math.floor(limit) || 0, 1), 1000)
  const rows = await query<{
    id: string
    created_at: string
    actor_id: string
    actor_name: string
    action: string
    target_id: string | null
    summary: string
    detail: Record<string, unknown> | null
  }>(
    `SELECT id, created_at, actor_id, actor_name, action, target_id, summary, detail
       FROM admin_audit_log
      ORDER BY id DESC
      LIMIT $1`,
    [capped],
  )
  return rows.map((r) => ({
    id: r.id,
    createdAt:
      typeof r.created_at === 'string'
        ? r.created_at
        : new Date(r.created_at).toISOString(),
    actorId: r.actor_id,
    actorName: r.actor_name,
    action: r.action,
    targetId: r.target_id,
    summary: r.summary,
    detail: r.detail,
  }))
}
