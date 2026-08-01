import 'server-only'

import {
  applyExperimentBranch,
  assignExperimentBranch,
  parseOverrides,
  type ActiveExperimentLite,
  type ExperimentBranch,
  type ExperimentOverrides,
  type OverridableSettings,
} from '@/lib/ai/experiment'
import { query } from '@/lib/db'
import { effectiveStatusSql } from './shared'

/** Full experiment row for the co-pilot's status/report tools. */
export interface AiExperiment {
  id: string
  name: string
  status: 'active' | 'stopped'
  overrides: ExperimentOverrides
  startedAt: string
  stoppedAt: string | null
  winner: ExperimentBranch | null
}

interface ExperimentRow {
  id: string
  name: string
  status: 'active' | 'stopped'
  overrides: unknown
  started_at: string
  stopped_at: string | null
  winner: ExperimentBranch | null
}

const rowToExperiment = (r: ExperimentRow): AiExperiment => ({
  id: r.id,
  name: r.name,
  status: r.status,
  overrides: parseOverrides(r.overrides),
  startedAt: r.started_at,
  stoppedAt: r.stopped_at,
  winner: r.winner,
})

const SELECT_COLS = 'id, name, status, overrides, started_at, stopped_at, winner'

/** The single active experiment, or null. Best-effort: pre-088 DB → null. */
export async function getActiveExperiment(): Promise<AiExperiment | null> {
  try {
    const rows = await query<ExperimentRow>(
      `SELECT ${SELECT_COLS} FROM ai_experiments WHERE status = 'active' LIMIT 1`,
    )
    return rows.length > 0 ? rowToExperiment(rows[0]) : null
  } catch {
    return null
  }
}

/**
 * Start a new experiment. Fails soft with reason 'already_active' when one is
 * already running (the partial unique index is the real guarantee; the
 * pre-check just produces a friendlier error for the co-pilot to relay).
 */
export async function startExperiment(input: {
  name: string
  overrides: ExperimentOverrides
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const existing = await getActiveExperiment()
  if (existing) return { ok: false, reason: 'already_active' }
  try {
    const rows = await query<{ id: string }>(
      `INSERT INTO ai_experiments (name, overrides)
       VALUES ($1, $2::jsonb) RETURNING id`,
      [input.name.trim().slice(0, 200), JSON.stringify(input.overrides)],
    )
    return { ok: true, id: rows[0].id }
  } catch (err) {
    // Unique-index race (two starts at once) or pre-migration schema.
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      reason: msg.includes('ai_experiments_one_active')
        ? 'already_active'
        : 'db_error',
    }
  }
}

/** Stop the active experiment, optionally recording a winner. */
export async function stopExperiment(
  winner: ExperimentBranch | null,
): Promise<{ ok: true; experiment: AiExperiment } | { ok: false; reason: string }> {
  const rows = await query<ExperimentRow>(
    `UPDATE ai_experiments
        SET status = 'stopped', stopped_at = now(), winner = $1
      WHERE status = 'active'
      RETURNING ${SELECT_COLS}`,
    [winner],
  ).catch(() => [] as ExperimentRow[])
  if (rows.length === 0) return { ok: false, reason: 'no_active' }
  return { ok: true, experiment: rowToExperiment(rows[0]) }
}

/** Per-branch outcome rollup, computed over recorded assignments only. */
export interface ExperimentBranchResults {
  branch: ExperimentBranch
  conversations: number
  liquid: number
  handoffs: number
  notLiquid: number
  liquidRatePct: number
}

export interface ExperimentResults {
  experiment: AiExperiment
  branches: ExperimentBranchResults[]
}

/**
 * Results for an experiment (defaults to the active one; falls back to the
 * most recently stopped so «как прошёл эксперимент?» works after stopping).
 * Counts only conversations that actually generated a reply under the
 * experiment (i.e. have an assignment row) — no phantom traffic.
 */
export async function getExperimentResults(): Promise<ExperimentResults | null> {
  const expRows = await query<ExperimentRow>(
    `SELECT ${SELECT_COLS} FROM ai_experiments
      ORDER BY (status = 'active') DESC, started_at DESC
      LIMIT 1`,
  ).catch(() => [] as ExperimentRow[])
  if (expRows.length === 0) return null
  const experiment = rowToExperiment(expRows[0])

  const rows = await query<{
    branch: ExperimentBranch
    status: string
    n: string | number
  }>(
    `SELECT a.branch, ${effectiveStatusSql('c')} AS status, COUNT(*) AS n
       FROM ai_experiment_assignments a
       JOIN conversations c ON c.id = a.conversation_id
      WHERE a.experiment_id = $1
      GROUP BY a.branch, ${effectiveStatusSql('c')}`,
    [experiment.id],
  )

  const mk = (branch: ExperimentBranch): ExperimentBranchResults => {
    const mine = rows.filter((r) => r.branch === branch)
    const count = (s: string) =>
      mine.filter((r) => r.status === s).reduce((a, r) => a + Number(r.n), 0)
    const conversations = mine.reduce((a, r) => a + Number(r.n), 0)
    const liquid = count('liquid')
    return {
      branch,
      conversations,
      liquid,
      handoffs: count('handoff'),
      notLiquid: count('not_liquid'),
      liquidRatePct:
        conversations === 0
          ? 0
          : Math.round((liquid / conversations) * 1000) / 10,
    }
  }
  return { experiment, branches: [mk('A'), mk('B')] }
}

/**
 * The one call reply paths make: overlay the active experiment (if any) onto a
 * settings snapshot for THIS conversation, and durably record the assignment.
 * No experiment / any failure → settings pass through untouched, because an
 * experiment must never be able to break replying to a real client.
 */
export async function applyActiveExperiment<T extends OverridableSettings>(
  settings: T,
  conversationId: string,
): Promise<{
  settings: T
  extraDirectives: string[]
  branch: ExperimentBranch | null
}> {
  try {
    const exp = await getActiveExperiment()
    if (!exp) return { settings, extraDirectives: [], branch: null }
    const lite: ActiveExperimentLite = {
      id: exp.id,
      name: exp.name,
      overrides: exp.overrides,
    }
    const branch = assignExperimentBranch(exp.id, conversationId)
    // Record fire-and-forget: results only count assigned conversations, and a
    // lost insert merely delays the row until this client's next reply.
    void query(
      `INSERT INTO ai_experiment_assignments (experiment_id, conversation_id, branch)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [exp.id, conversationId, branch],
    ).catch(() => {})
    const applied = applyExperimentBranch(settings, lite, branch)
    return { ...applied, branch }
  } catch {
    return { settings, extraDirectives: [], branch: null }
  }
}
