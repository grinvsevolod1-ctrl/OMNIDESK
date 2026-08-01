/**
 * Data layer for the admin co-pilot's own "brains":
 *
 * - Business-memory notes: durable facts about the admin's business that the
 *   co-pilot loads into every turn, surviving the trimmed chat history.
 * - Seller check-cases: saved client messages + expectations, re-run through
 *   the real seller brain after rule changes to catch regressions.
 *
 * Plain parameterized SQL over lib/db, matching the rest of lib/data.
 */
import { query } from '../db'

/* ------------------------------ memory notes ----------------------------- */

export interface CopilotNote {
  id: string
  body: string
  createdAt: string
}

const NOTE_MAX = 1000
/** Hard cap on stored notes so the per-turn context stays small. */
export const NOTES_CAP = 40

export async function listCopilotNotes(limit = NOTES_CAP): Promise<CopilotNote[]> {
  const cap = Math.max(1, Math.min(NOTES_CAP, Math.round(limit)))
  const rows = await query<{ id: string; body: string; created_at: string }>(
    `SELECT id, body, created_at FROM ai_copilot_notes
      ORDER BY created_at DESC
      LIMIT $1`,
    [cap],
  )
  return rows.map((r) => ({ id: r.id, body: r.body, createdAt: r.created_at }))
}

/**
 * Remember a business fact. Refuses beyond NOTES_CAP so a chatty model can
 * never flood the table; the co-pilot should then consolidate or forget first.
 */
export async function addCopilotNote(
  body: string,
): Promise<{ ok: true; id: string } | { ok: false; reason: 'cap_reached' | 'empty' }> {
  const text = body.trim().slice(0, NOTE_MAX)
  if (!text) return { ok: false, reason: 'empty' }
  const [{ n }] = await query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM ai_copilot_notes`,
  )
  if (Number(n) >= NOTES_CAP) return { ok: false, reason: 'cap_reached' }
  const [row] = await query<{ id: string }>(
    `INSERT INTO ai_copilot_notes (body) VALUES ($1) RETURNING id`,
    [text],
  )
  return { ok: true, id: row.id }
}

export async function deleteCopilotNote(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM ai_copilot_notes WHERE id = $1 RETURNING id`,
    [id],
  )
  return rows.length > 0
}

/* ------------------------------- check cases ----------------------------- */

export interface CheckCase {
  id: string
  clientMessage: string
  expectation: string
  enabled: boolean
  createdAt: string
}

/** Hard cap on stored cases; runs are separately capped in the tool layer. */
export const CHECK_CASES_CAP = 30

export async function listCheckCases(
  onlyEnabled = false,
): Promise<CheckCase[]> {
  const rows = await query<{
    id: string
    client_message: string
    expectation: string
    enabled: boolean
    created_at: string
  }>(
    `SELECT id, client_message, expectation, enabled, created_at
       FROM ai_check_cases
      ${onlyEnabled ? 'WHERE enabled = true' : ''}
      ORDER BY created_at ASC
      LIMIT $1`,
    [CHECK_CASES_CAP],
  )
  return rows.map((r) => ({
    id: r.id,
    clientMessage: r.client_message,
    expectation: r.expectation,
    enabled: r.enabled,
    createdAt: r.created_at,
  }))
}

export async function addCheckCase(input: {
  clientMessage: string
  expectation: string
}): Promise<{ ok: true; id: string } | { ok: false; reason: 'cap_reached' | 'empty' }> {
  const msg = input.clientMessage.trim().slice(0, 2000)
  const exp = input.expectation.trim().slice(0, 1000)
  if (!msg || !exp) return { ok: false, reason: 'empty' }
  const [{ n }] = await query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM ai_check_cases`,
  )
  if (Number(n) >= CHECK_CASES_CAP) return { ok: false, reason: 'cap_reached' }
  const [row] = await query<{ id: string }>(
    `INSERT INTO ai_check_cases (client_message, expectation) VALUES ($1, $2)
     RETURNING id`,
    [msg, exp],
  )
  return { ok: true, id: row.id }
}

export async function deleteCheckCase(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM ai_check_cases WHERE id = $1 RETURNING id`,
    [id],
  )
  return rows.length > 0
}
