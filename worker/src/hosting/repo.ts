import { one, query } from '../db.js'
import { decrypt, decryptJson } from '../crypto.js'

/**
 * Worker-side data access for App Hosting. Reads decrypt SSH secrets / app env
 * (plaintext stays inside the worker, never logged), writes advance job and
 * deployment state and append streamed log lines. Mirrors the panel's
 * lib/data/hosting.ts but with the worker's `pg` helpers.
 */

export type DeployAction =
  | 'deploy'
  | 'start'
  | 'stop'
  | 'restart'
  | 'remove'
  | 'health_check'
  | 'ai_deploy'

export interface DeployJob {
  id: string
  server_id: string | null
  app_id: string | null
  deployment_id: string | null
  action: DeployAction
  payload: Record<string, unknown>
  status: string
}

export interface ServerRecord {
  id: string
  name: string
  ip_address: string
  ssh_port: number
  auth_type: 'ssh_key' | 'password'
  ssh_username: string
  /** Decrypted secret (private key PEM or password), or null when unset. */
  secret: string | null
  host_fingerprint: string | null
  /** The agent's short memory about this box (OS, what's installed), or null. */
  agent_notes: string | null
}

export interface AppRecord {
  id: string
  server_id: string
  name: string
  repo_url: string
  branch: string
  domain: string | null
  runtime: 'node' | 'docker' | 'static' | 'php'
  /** Decrypted environment map (empty when none). */
  env: Record<string, string>
  /** Decrypted GitHub token for cloning a private repo, or null. */
  repoToken: string | null
  port: number | null
  status: string
  /** Agent memory about THIS app (how it was built/run), or null. */
  agent_notes: string | null
}

/* ------------------------------- Jobs ------------------------------- */

/** Atomically claim a queued deploy job (skip-locked concurrency safety). */
export async function claimJob(jobId: string): Promise<DeployJob | null> {
  return one<DeployJob>(
    `UPDATE deploy_jobs
       SET status = 'running', updated_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING id, server_id, app_id, deployment_id, action, payload, status`,
    [jobId],
  )
}

/** Claim the next queued job on startup (in case a NOTIFY was missed). */
export async function claimNextQueued(): Promise<DeployJob | null> {
  return one<DeployJob>(
    `UPDATE deploy_jobs
       SET status = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM deploy_jobs
        WHERE status = 'queued'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING id, server_id, app_id, deployment_id, action, payload, status`,
  )
}

export async function finishJob(
  jobId: string,
  ok: boolean,
  result: Record<string, unknown> | null,
  error: string | null,
): Promise<void> {
  await query(
    `UPDATE deploy_jobs
       SET status = $2, result = $3, last_error = $4, updated_at = now()
     WHERE id = $1`,
    [jobId, ok ? 'done' : 'error', result ? JSON.stringify(result) : null, error],
  )
}

/* ------------------------------ Servers ----------------------------- */

interface ServerRow {
  id: string
  name: string
  ip_address: string
  ssh_port: number
  auth_type: 'ssh_key' | 'password'
  ssh_username: string
  secret_encrypted: string | null
  host_fingerprint: string | null
  agent_notes: string | null
}

export async function getServer(id: string): Promise<ServerRecord | null> {
  const row = await one<ServerRow>(
    `SELECT id, name, ip_address, ssh_port, auth_type, ssh_username,
            secret_encrypted, host_fingerprint, agent_notes
       FROM hosting_servers WHERE id = $1`,
    [id],
  )
  if (!row) return null
  let secret: string | null = null
  try {
    if (row.secret_encrypted) secret = decrypt(row.secret_encrypted)
  } catch {
    secret = null
  }
  return {
    id: row.id,
    name: row.name,
    ip_address: row.ip_address,
    ssh_port: Number(row.ssh_port),
    auth_type: row.auth_type,
    ssh_username: row.ssh_username,
    secret,
    host_fingerprint: row.host_fingerprint,
    agent_notes: row.agent_notes ?? null,
  }
}

/** Persist the agent's short memory about a server (best-effort). */
export async function setServerAgentNotes(
  serverId: string,
  notes: string,
): Promise<void> {
  await query('UPDATE hosting_servers SET agent_notes = $2 WHERE id = $1', [
    serverId,
    notes.slice(0, 4000),
  ])
}

/** Persist the pinned host-key fingerprint captured on first connect. */
export async function pinServerFingerprint(
  serverId: string,
  fingerprint: string,
): Promise<void> {
  await query(
    `UPDATE hosting_servers SET host_fingerprint = $2 WHERE id = $1
       AND host_fingerprint IS NULL`,
    [serverId, fingerprint],
  )
}

export async function setServerHealth(
  serverId: string,
  status: 'online' | 'offline' | 'unknown',
  metrics: Record<string, unknown> | null,
  error: string | null,
): Promise<void> {
  await query(
    `UPDATE hosting_servers
       SET status = $2,
           metrics = COALESCE($3::jsonb, metrics),
           last_error = $4,
           last_checked_at = now()
     WHERE id = $1`,
    [serverId, status, metrics ? JSON.stringify(metrics) : null, error],
  )
}

/* -------------------------------- Apps ------------------------------ */

interface AppRow {
  id: string
  server_id: string
  name: string
  repo_url: string
  branch: string
  domain: string | null
  runtime: 'node' | 'docker' | 'static' | 'php'
  env_encrypted: string | null
  repo_token_encrypted: string | null
  port: number | null
  status: string
  agent_notes: string | null
}

export async function getApp(id: string): Promise<AppRecord | null> {
  const row = await one<AppRow>(
    `SELECT id, server_id, name, repo_url, branch, domain, runtime,
            env_encrypted, repo_token_encrypted, port, status, agent_notes
       FROM hosting_apps WHERE id = $1`,
    [id],
  )
  if (!row) return null
  let env: Record<string, string> = {}
  try {
    if (row.env_encrypted) {
      const decoded = decryptJson<Record<string, string>>(row.env_encrypted)
      if (decoded && typeof decoded === 'object') env = decoded
    }
  } catch {
    env = {}
  }
  let repoToken: string | null = null
  try {
    if (row.repo_token_encrypted) repoToken = decrypt(row.repo_token_encrypted)
  } catch {
    repoToken = null
  }
  return {
    id: row.id,
    server_id: row.server_id,
    name: row.name,
    repo_url: row.repo_url,
    branch: row.branch,
    domain: row.domain,
    runtime: row.runtime,
    env,
    repoToken,
    port: row.port === null ? null : Number(row.port),
    status: row.status,
    agent_notes: row.agent_notes ?? null,
  }
}

/** Persist the agent's memory about an app (best-effort, truncated). */
export async function setAppAgentNotes(
  appId: string,
  notes: string,
): Promise<void> {
  await query('UPDATE hosting_apps SET agent_notes = $2 WHERE id = $1', [
    appId,
    notes.slice(0, 4000),
  ])
}

/** Record how many LLM tokens a deployment consumed (cost visibility). */
export async function setDeploymentTokens(
  deploymentId: string,
  tokens: number,
): Promise<void> {
  await query('UPDATE hosting_deployments SET tokens_used = $2 WHERE id = $1', [
    deploymentId,
    Math.round(tokens),
  ])
}

export async function setAppStatus(
  appId: string,
  status: 'stopped' | 'building' | 'running' | 'error',
  error: string | null,
): Promise<void> {
  await query(
    `UPDATE hosting_apps
       SET status = $2, last_error = $3, updated_at = now()
     WHERE id = $1`,
    [appId, status, error],
  )
}

/**
 * Delete an app record after its process and code have been removed from the
 * server (called at the end of a 'remove' lifecycle job so cleanup is atomic
 * and the console doesn't have to race the worker to delete the row).
 */
export async function deleteApp(appId: string): Promise<void> {
  await query('DELETE FROM hosting_apps WHERE id = $1', [appId])
}

/** Apps on a server that claim to be running and have a probeable port. */
export async function listProbeableApps(
  serverId: string,
): Promise<Array<{ id: string; name: string; runtime: string; port: number; health_fail_count: number }>> {
  return query(
    `SELECT id, name, runtime, port, health_fail_count
       FROM hosting_apps
      WHERE server_id = $1 AND status = 'running' AND port IS NOT NULL`,
    [serverId],
  )
}

/**
 * Record an app health-probe result. Returns the NEW consecutive-failure count
 * (0 after a success) so the sweeper can decide to restart or flag the app.
 */
export async function recordAppHealth(
  appId: string,
  healthy: boolean,
): Promise<number> {
  const row = await one<{ health_fail_count: number }>(
    `UPDATE hosting_apps
        SET health_fail_count = CASE WHEN $2 THEN 0 ELSE health_fail_count + 1 END,
            updated_at = now()
      WHERE id = $1
      RETURNING health_fail_count`,
    [appId, healthy],
  )
  return row ? Number(row.health_fail_count) : 0
}

/* ----------------------------- Deployments -------------------------- */

export async function setDeploymentStatus(
  deploymentId: string,
  status: string,
  opts: {
    commitHash?: string | null
    started?: boolean
    finished?: boolean
    summary?: string | null
    siteUrl?: string | null
  } = {},
): Promise<void> {
  await query(
    `UPDATE hosting_deployments
       SET status = $2,
           commit_hash = COALESCE($3, commit_hash),
           started_at  = CASE WHEN $4 THEN now() ELSE started_at END,
           finished_at = CASE WHEN $5 THEN now() ELSE finished_at END,
           summary = COALESCE($6, summary),
           site_url = COALESCE($7, site_url)
     WHERE id = $1`,
    [
      deploymentId,
      status,
      opts.commitHash ?? null,
      opts.started ?? false,
      opts.finished ?? false,
      opts.summary ?? null,
      opts.siteUrl ?? null,
    ],
  )
}

/**
 * Read a deployment's current status. The autonomous agent polls this between
 * steps: if the admin cancelled it (status flipped to a terminal state), the
 * agent aborts gracefully instead of continuing to run commands.
 */
export async function getDeploymentStatus(
  deploymentId: string,
): Promise<string | null> {
  const row = await one<{ status: string }>(
    'SELECT status FROM hosting_deployments WHERE id = $1',
    [deploymentId],
  )
  return row?.status ?? null
}

/**
 * Fail any deployment left actively running (cloning/building/running) — these
 * are orphans from a worker that crashed or was redeployed mid-run: their SSH
 * connection is long gone and nothing will ever advance them. Genuinely
 * `queued` deployments are left alone so drainDeployQueue can still execute
 * them normally. Called once on startup so the panel never shows a deploy stuck
 * "running" forever, and the app is marked errored so the admin can retry.
 * Returns the number of deployments recovered.
 */
export async function recoverStuckDeployments(): Promise<number> {
  const stuck = await query<{ id: string; app_id: string }>(
    `UPDATE hosting_deployments
        SET status = 'failed',
            summary = COALESCE(summary, 'Прервано: воркер был перезапущен во время установки.'),
            finished_at = now()
      WHERE status IN ('cloning', 'building', 'running')
      RETURNING id, app_id`,
  )
  for (const row of stuck) {
    await appendDeployLog(
      row.id,
      'system',
      'Установка прервана: воркер перезапустился. Запустите деплой заново.',
    ).catch(() => {})
    await setAppStatus(row.app_id, 'error', 'Прервано перезапуском воркера').catch(
      () => {},
    )
  }
  return stuck.length
}

/**
 * Append a log line to a deployment. seq is assigned atomically as
 * max(seq)+1 for the deployment so the SSE cursor stays gap-free even under
 * concurrent writers.
 */
export async function appendDeployLog(
  deploymentId: string,
  stream: 'stdout' | 'stderr' | 'system' | 'agent' | 'command',
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
