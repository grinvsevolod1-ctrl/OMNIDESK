import 'server-only'
import { query } from '../db'

/**
 * The chat-driven "mandate" for the AI sales manager: an ordered, individually
 * toggleable list of plain-language rules the admin dictates to the co-pilot.
 * These are durable (survive training re-distills) and injected into EVERY
 * reply at the highest priority. See scripts/085_ai_directives.sql.
 *
 * Strictly AI-manager scope — never touched by the client simulator or the god
 * panel.
 */
export interface AiDirective {
  id: string
  body: string
  sortOrder: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface DirectiveRow {
  id: string
  body: string
  sort_order: number | string
  enabled: boolean
  created_at: string | Date
  updated_at: string | Date
}

function mapDirective(r: DirectiveRow): AiDirective {
  return {
    id: r.id,
    body: r.body ?? '',
    sortOrder: Number(r.sort_order) || 0,
    enabled: !!r.enabled,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

const MAX_BODY = 2000
const MAX_DIRECTIVES = 300

/** All directives, ordered as they will appear in the prompt. */
export async function listDirectives(opts?: {
  enabledOnly?: boolean
}): Promise<AiDirective[]> {
  const rows = await query<DirectiveRow>(
    `SELECT id, body, sort_order, enabled, created_at, updated_at
       FROM ai_directives
      ${opts?.enabledOnly ? 'WHERE enabled = true' : ''}
      ORDER BY sort_order ASC, created_at ASC`,
  )
  return rows.map(mapDirective)
}

/**
 * The active mandate as plain strings, in order — exactly what gets injected
 * into ManagerBrainInput.directives. Best-effort: returns [] if the table is
 * missing (pre-migration) so a reply is never blocked.
 */
export async function directiveTexts(): Promise<string[]> {
  try {
    const rows = await listDirectives({ enabledOnly: true })
    return rows.map((d) => d.body.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** How many directives exist (for the co-pilot status readout). */
export async function countDirectives(): Promise<number> {
  try {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ai_directives`,
    )
    return Number(rows[0]?.n) || 0
  } catch {
    return 0
  }
}

/**
 * Append a new directive at the end of the list. Returns the created row.
 * Enforces a sane cap so the prompt can't grow unbounded.
 */
export async function addDirective(body: string): Promise<AiDirective> {
  const clean = body.trim().slice(0, MAX_BODY)
  if (!clean) throw new Error('empty_directive')

  const countRows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ai_directives`,
  )
  if ((Number(countRows[0]?.n) || 0) >= MAX_DIRECTIVES) {
    throw new Error('too_many_directives')
  }

  const rows = await query<DirectiveRow>(
    `INSERT INTO ai_directives (body, sort_order)
     VALUES (
       $1,
       COALESCE((SELECT MAX(sort_order) + 1 FROM ai_directives), 0)
     )
     RETURNING id, body, sort_order, enabled, created_at, updated_at`,
    [clean],
  )
  return mapDirective(rows[0])
}

/** Rewrite the text of one directive. Returns the updated row, or null. */
export async function updateDirective(
  id: string,
  body: string,
): Promise<AiDirective | null> {
  const clean = body.trim().slice(0, MAX_BODY)
  if (!clean) throw new Error('empty_directive')
  const rows = await query<DirectiveRow>(
    `UPDATE ai_directives
        SET body = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, body, sort_order, enabled, created_at, updated_at`,
    [id, clean],
  )
  return rows[0] ? mapDirective(rows[0]) : null
}

/** Pause or resume one directive without deleting it. */
export async function setDirectiveEnabled(
  id: string,
  enabled: boolean,
): Promise<AiDirective | null> {
  const rows = await query<DirectiveRow>(
    `UPDATE ai_directives
        SET enabled = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, body, sort_order, enabled, created_at, updated_at`,
    [id, enabled],
  )
  return rows[0] ? mapDirective(rows[0]) : null
}

/** Permanently delete one directive. Returns true if a row was removed. */
export async function removeDirective(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM ai_directives WHERE id = $1 RETURNING id`,
    [id],
  )
  return rows.length > 0
}

/**
 * Re-rank directives to match the given id order. Ids not present are left after
 * the provided ones (their relative order preserved). Unknown ids are ignored.
 */
export async function reorderDirectives(orderedIds: string[]): Promise<void> {
  const ids = orderedIds.filter(Boolean)
  if (ids.length === 0) return
  // Assign 0..n-1 to the provided ids in one statement via a VALUES map.
  const values = ids.map((_, i) => `($${i + 1}, ${i})`).join(', ')
  await query(
    `UPDATE ai_directives AS d
        SET sort_order = v.ord, updated_at = now()
       FROM (VALUES ${values}) AS v(id, ord)
      WHERE d.id = v.id::uuid`,
    ids,
  )
}
