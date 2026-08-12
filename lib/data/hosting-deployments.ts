/**
 * App Hosting deploy pipeline: deployment history, streamed deploy logs and
 * the deploy-job queue the worker consumes. Split out of lib/data/hosting.ts
 * (which keeps servers + apps CRUD); consumers keep importing everything from
 * '@/lib/data/hosting' thanks to the re-export there.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import { encrypt } from '../crypto'
import type {
  DeployAction,
  DeploymentMode,
  DeploymentStatus,
  HostingDeployLog,
  HostingDeployment,
} from '../types'

/* ----------------------------- Deployments ----------------------------- */

interface DeploymentRow {
  id: string
  app_id: string
  commit_hash: string | null
  status: DeploymentStatus
  trigger: string
  mode: DeploymentMode
  summary: string | null
  site_url: string | null
  started_at: string | Date | null
  finished_at: string | Date | null
  created_at: string | Date
}

const DEPLOYMENT_COLUMNS =
  'id, app_id, commit_hash, status, trigger, mode, summary, site_url, ' +
  'started_at, finished_at, created_at'

function toDeployment(r: DeploymentRow): HostingDeployment {
  return {
    id: r.id,
    appId: r.app_id,
    commitHash: r.commit_hash ?? null,
    status: r.status,
    trigger: r.trigger,
    mode: r.mode ?? 'manual',
    summary: r.summary ?? null,
    siteUrl: r.site_url ?? null,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

export async function listDeploymentsForApp(
  appId: string,
  limit = 20,
): Promise<HostingDeployment[]> {
  const rows = await query<DeploymentRow>(
    `SELECT ${DEPLOYMENT_COLUMNS}
       FROM hosting_deployments
      WHERE app_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [appId, limit],
  )
  return rows.map(toDeployment)
}

export async function getDeploymentById(
  id: string,
): Promise<HostingDeployment | null> {
  const rows = await query<DeploymentRow>(
    `SELECT ${DEPLOYMENT_COLUMNS}
       FROM hosting_deployments WHERE id = $1 LIMIT 1`,
    [id],
  )
  return rows[0] ? toDeployment(rows[0]) : null
}

/** Create a queued deployment row (the worker advances its status). */
export async function createDeployment(
  appId: string,
  trigger: string,
  mode: DeploymentMode = 'manual',
): Promise<HostingDeployment> {
  const id = randomUUID()
  const rows = await query<DeploymentRow>(
    `INSERT INTO hosting_deployments (id, app_id, status, trigger, mode)
     VALUES ($1, $2, 'queued', $3, $4)
     RETURNING ${DEPLOYMENT_COLUMNS}`,
    [id, appId, trigger, mode],
  )
  return toDeployment(rows[0])
}

/**
 * Cancel an in-flight deployment: mark it failed with a summary and append a
 * log line so the live viewer shows the cancellation. The autonomous agent
 * polls the deployment status between steps and aborts once it's no longer
 * active. Only affects deployments that haven't already reached a terminal
 * state. Returns true when a row was actually cancelled.
 */
export async function cancelDeployment(deploymentId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE hosting_deployments
        SET status = 'failed',
            summary = COALESCE(summary, 'Отменено администратором'),
            finished_at = now()
      WHERE id = $1 AND status NOT IN ('success', 'failed')
      RETURNING id`,
    [deploymentId],
  )
  if (rows.length > 0) {
    await appendDeployLog(deploymentId, 'system', 'Установка отменена администратором.')
  }
  return rows.length > 0
}

/** Store (or clear) the encrypted GitHub token used to clone a private repo. */
export async function setAppRepoToken(
  appId: string,
  token: string | null,
): Promise<void> {
  const enc = token ? encrypt(token) : null
  await query(
    'UPDATE hosting_apps SET repo_token_encrypted = $2, updated_at = now() WHERE id = $1',
    [appId, enc],
  )
}

/* ------------------------------ Deploy logs ---------------------------- */

/**
 * Append a log line to a deployment (panel-side mirror of the worker's writer).
 * seq is assigned atomically as max(seq)+1 so the SSE cursor stays gap-free.
 * Used to record admin-initiated events like a cancellation.
 */
export async function appendDeployLog(
  deploymentId: string,
  stream: HostingDeployLog['stream'],
  line: string,
): Promise<void> {
  await query(
    `INSERT INTO hosting_deploy_logs (deployment_id, seq, stream, line)
     VALUES (
       $1,
       COALESCE((SELECT max(seq) FROM hosting_deploy_logs WHERE deployment_id = $1), 0) + 1,
       $2,
       $3
     )`,
    [deploymentId, stream, line],
  )
}

interface DeployLogRow {
  id: string | number
  deployment_id: string
  seq: number
  stream: HostingDeployLog['stream']
  line: string
  created_at: string | Date
}

function toDeployLog(r: DeployLogRow): HostingDeployLog {
  return {
    id: Number(r.id),
    deploymentId: r.deployment_id,
    seq: Number(r.seq),
    stream: r.stream,
    line: r.line,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/**
 * Read log lines for a deployment after a given seq cursor (exclusive). The SSE
 * route uses this both to replay history (afterSeq = 0) and to tail new lines
 * (afterSeq = last delivered seq).
 */
export async function listDeployLogs(
  deploymentId: string,
  afterSeq = 0,
): Promise<HostingDeployLog[]> {
  const rows = await query<DeployLogRow>(
    `SELECT id, deployment_id, seq, stream, line, created_at
       FROM hosting_deploy_logs
      WHERE deployment_id = $1 AND seq > $2
      ORDER BY seq ASC`,
    [deploymentId, afterSeq],
  )
  return rows.map(toDeployLog)
}

/* ------------------------------ Job queue ------------------------------ */

/**
 * Enqueue a command for the hosting worker. The AFTER INSERT trigger fires
 * pg_notify('deploy_jobs', id) so the worker picks it up instantly; it also
 * drains the queue on startup in case a NOTIFY was missed while it was down.
 */
export async function enqueueDeployJob(input: {
  action: DeployAction
  serverId?: string | null
  appId?: string | null
  deploymentId?: string | null
  payload?: Record<string, unknown>
}): Promise<string> {
  const id = randomUUID()
  await query(
    `INSERT INTO deploy_jobs
       (id, server_id, app_id, deployment_id, action, payload, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'queued')`,
    [
      id,
      input.serverId ?? null,
      input.appId ?? null,
      input.deploymentId ?? null,
      input.action,
      JSON.stringify(input.payload ?? {}),
    ],
  )
  return id
}
