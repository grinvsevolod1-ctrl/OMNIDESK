/**
 * App Hosting ("Серверы"): CRUD for managed servers and their apps, deploy
 * history + streamed logs, and the deploy-job queue the worker consumes.
 *
 * Secrets (SSH key/password, app env vars) are encrypted at rest via lib/crypto
 * and NEVER returned to the client — reads expose only booleans/masks and env
 * KEYS. Long-running work (clone/build/run over SSH) is delegated to the worker
 * by enqueueing a row in deploy_jobs; nothing here touches SSH directly.
 * Split out of the monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import { decryptJson, encrypt, encryptJson } from '../crypto'
import type {
  AppRuntime,
  AppStatus,
  DeployAction,
  DeploymentMode,
  DeploymentStatus,
  HostingApp,
  HostingDeployLog,
  HostingDeployment,
  HostingServer,
  ServerAuthType,
  ServerMetrics,
  ServerStatus,
} from '../types'

/* ------------------------------- Servers ------------------------------- */

interface ServerRow {
  id: string
  name: string
  ip_address: string
  ssh_port: number
  auth_type: ServerAuthType
  ssh_username: string
  secret_encrypted: string | null
  host_fingerprint: string | null
  status: ServerStatus
  metrics: unknown
  last_error: string | null
  last_checked_at: string | Date | null
  created_at: string | Date
  app_count?: number | string
}

// Explicit column list (never SELECT *) so the encrypted secret only travels
// when a query asks for it and a future column can't silently widen reads.
const SERVER_COLUMN_NAMES = [
  'id', 'name', 'ip_address', 'ssh_port', 'auth_type', 'ssh_username',
  'secret_encrypted', 'host_fingerprint', 'status', 'metrics', 'last_error',
  'last_checked_at', 'created_at',
] as const

function serverColumns(alias = 'hosting_servers'): string {
  return SERVER_COLUMN_NAMES.map((c) => `${alias}.${c}`).join(', ')
}

function toMetrics(raw: unknown): ServerMetrics {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null
  return {
    cpu: num(m.cpu),
    mem: num(m.mem),
    disk: num(m.disk),
    uptime: typeof m.uptime === 'string' ? m.uptime : null,
  }
}

function toServer(r: ServerRow): HostingServer {
  return {
    id: r.id,
    name: r.name,
    ipAddress: r.ip_address,
    sshPort: Number(r.ssh_port),
    authType: r.auth_type,
    sshUsername: r.ssh_username,
    hasSecret: Boolean(r.secret_encrypted),
    hostKeyPinned: Boolean(r.host_fingerprint),
    status: r.status,
    metrics: toMetrics(r.metrics),
    lastError: r.last_error ?? null,
    lastCheckedAt: r.last_checked_at
      ? new Date(r.last_checked_at).toISOString()
      : null,
    createdAt: new Date(r.created_at).toISOString(),
    ...(r.app_count !== undefined ? { appCount: Number(r.app_count) } : {}),
  }
}

/** Every managed server with its app count, newest first. */
export async function listServers(): Promise<HostingServer[]> {
  const rows = await query<ServerRow>(
    `SELECT ${serverColumns('s')},
            (SELECT count(*) FROM hosting_apps a WHERE a.server_id = s.id) AS app_count
       FROM hosting_servers s
      ORDER BY s.created_at DESC`,
  )
  return rows.map(toServer)
}

export async function getServerById(id: string): Promise<HostingServer | null> {
  const rows = await query<ServerRow>(
    `SELECT ${serverColumns()} FROM hosting_servers WHERE id = $1 LIMIT 1`,
    [id],
  )
  return rows[0] ? toServer(rows[0]) : null
}

export async function createServer(input: {
  name: string
  ipAddress: string
  sshPort: number
  authType: ServerAuthType
  sshUsername: string
  /** Private key (PEM) or password — encrypted at rest. */
  secret?: string | null
}): Promise<HostingServer> {
  const id = randomUUID()
  const secretEnc = input.secret ? encrypt(input.secret) : null
  const rows = await query<ServerRow>(
    `INSERT INTO hosting_servers
       (id, name, ip_address, ssh_port, auth_type, ssh_username, secret_encrypted, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'unknown')
     RETURNING ${SERVER_COLUMN_NAMES.join(', ')}`,
    [
      id,
      input.name,
      input.ipAddress,
      input.sshPort,
      input.authType,
      input.sshUsername,
      secretEnc,
    ],
  )
  return toServer(rows[0])
}

export async function deleteServer(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM hosting_servers WHERE id = $1 RETURNING id',
    [id],
  )
  return rows.length > 0
}

/* -------------------------------- Apps --------------------------------- */

interface AppRow {
  id: string
  server_id: string
  name: string
  repo_url: string
  branch: string
  domain: string | null
  runtime: AppRuntime
  env_encrypted: string | null
  repo_token_encrypted: string | null
  port: number | null
  status: AppStatus
  last_error: string | null
  auto_deploy: boolean
  created_at: string | Date
  updated_at: string | Date
}

const APP_COLUMN_NAMES = [
  'id', 'server_id', 'name', 'repo_url', 'branch', 'domain', 'runtime',
  'env_encrypted', 'repo_token_encrypted', 'port', 'status', 'last_error',
  'auto_deploy', 'created_at', 'updated_at',
] as const

function appColumns(alias = 'hosting_apps'): string {
  return APP_COLUMN_NAMES.map((c) => `${alias}.${c}`).join(', ')
}

/**
 * Decode env KEYS from the encrypted envelope WITHOUT exposing values. Failure
 * (missing/rotated key) degrades to an empty list rather than throwing, so the
 * app row still renders.
 */
function envKeysOf(envEncrypted: string | null): string[] {
  if (!envEncrypted) return []
  try {
    const obj = decryptJson<Record<string, unknown>>(envEncrypted)
    return obj && typeof obj === 'object' ? Object.keys(obj) : []
  } catch {
    return []
  }
}

function toApp(r: AppRow): HostingApp {
  return {
    id: r.id,
    serverId: r.server_id,
    name: r.name,
    repoUrl: r.repo_url,
    branch: r.branch,
    domain: r.domain ?? null,
    runtime: r.runtime,
    envKeys: envKeysOf(r.env_encrypted),
    port: r.port === null ? null : Number(r.port),
    status: r.status,
    lastError: r.last_error ?? null,
    hasRepoToken: Boolean(r.repo_token_encrypted),
    autoDeploy: Boolean(r.auto_deploy),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

export async function listAppsForServer(serverId: string): Promise<HostingApp[]> {
  const rows = await query<AppRow>(
    `SELECT ${appColumns()} FROM hosting_apps
      WHERE server_id = $1 ORDER BY created_at DESC`,
    [serverId],
  )
  return rows.map(toApp)
}

export async function getAppById(id: string): Promise<HostingApp | null> {
  const rows = await query<AppRow>(
    `SELECT ${appColumns()} FROM hosting_apps WHERE id = $1 LIMIT 1`,
    [id],
  )
  return rows[0] ? toApp(rows[0]) : null
}

/** Port range reserved for hosted apps on a managed server. */
const APP_PORT_MIN = 3001
const APP_PORT_MAX = 3999

/**
 * Allocate the smallest free port for an app on a server. Ports are a real
 * registry (unique index on server_id+port), so two concurrent deploys can't
 * grab the same one — the loser of the race gets a constraint error at INSERT
 * and the caller can retry. Returns null when the range is exhausted.
 */
export async function allocateAppPort(serverId: string): Promise<number | null> {
  const rows = await query<{ p: number }>(
    `SELECT p
       FROM generate_series($2::int, $3::int) AS p
      WHERE NOT EXISTS (
        SELECT 1 FROM hosting_apps
         WHERE server_id = $1 AND port = p
      )
      ORDER BY p
      LIMIT 1`,
    [serverId, APP_PORT_MIN, APP_PORT_MAX],
  )
  return rows[0] ? Number(rows[0].p) : null
}

export async function createApp(input: {
  serverId: string
  name: string
  repoUrl: string
  branch: string
  domain?: string | null
  runtime: AppRuntime
  port?: number | null
  env?: Record<string, string> | null
  /** GitHub token for cloning a private repo — encrypted at rest. */
  repoToken?: string | null
}): Promise<HostingApp> {
  const id = randomUUID()
  const envEnc =
    input.env && Object.keys(input.env).length > 0
      ? encryptJson(input.env)
      : null
  const tokenEnc = input.repoToken ? encrypt(input.repoToken) : null
  // Every app gets a reserved port up front so the deploy agent never has to
  // guess and parallel deploys can't collide. Static sites may not use it.
  const port = input.port ?? (await allocateAppPort(input.serverId))
  const rows = await query<AppRow>(
    `INSERT INTO hosting_apps
       (id, server_id, name, repo_url, branch, domain, runtime, env_encrypted,
        repo_token_encrypted, port, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'stopped')
     RETURNING ${APP_COLUMN_NAMES.join(', ')}`,
    [
      id,
      input.serverId,
      input.name,
      input.repoUrl,
      input.branch,
      input.domain ?? null,
      input.runtime,
      envEnc,
      tokenEnc,
      port,
    ],
  )
  return toApp(rows[0])
}

/**
 * Merge a patch into the app's encrypted env map: set/overwrite the given
 * keys, drop the ones in removeKeys. Returns the resulting key list (never
 * values). Used by the console assistant so "добавь переменную X" doesn't
 * wipe the rest of the map like updateAppEnv's whole-map replace would.
 */
export async function mergeAppEnv(
  id: string,
  patch: Record<string, string>,
  removeKeys: string[] = [],
): Promise<string[]> {
  const rows = await query<{ env_encrypted: string | null }>(
    'SELECT env_encrypted FROM hosting_apps WHERE id = $1 LIMIT 1',
    [id],
  )
  if (!rows[0]) return []
  let current: Record<string, string> = {}
  try {
    if (rows[0].env_encrypted) {
      const decoded = decryptJson<Record<string, string>>(rows[0].env_encrypted)
      if (decoded && typeof decoded === 'object') current = decoded
    }
  } catch {
    current = {}
  }
  for (const key of removeKeys) delete current[key]
  Object.assign(current, patch)
  await updateAppEnv(id, current)
  return Object.keys(current)
}

/** Set or clear the app's domain. */
export async function setAppDomain(
  id: string,
  domain: string | null,
): Promise<void> {
  await query(
    'UPDATE hosting_apps SET domain = $2, updated_at = now() WHERE id = $1',
    [id, domain],
  )
}

/** Opt an app in/out of GitHub-push auto redeploys. */
export async function setAppAutoDeploy(
  id: string,
  enabled: boolean,
): Promise<void> {
  await query(
    'UPDATE hosting_apps SET auto_deploy = $2, updated_at = now() WHERE id = $1',
    [id, enabled],
  )
}

/**
 * Find apps that auto-deploy from a given repository+branch. Matching is
 * normalized (case-insensitive, trailing `.git`/slash stripped) so the GitHub
 * webhook payload's clone/html URL matches however the admin typed the repo.
 */
export async function listAutoDeployApps(
  repoUrl: string,
  branch: string,
): Promise<HostingApp[]> {
  const normalize = (u: string): string =>
    u.toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '')
  const target = normalize(repoUrl)
  const rows = await query<AppRow>(
    `SELECT ${appColumns()} FROM hosting_apps
      WHERE auto_deploy = true AND branch = $1`,
    [branch],
  )
  return rows.filter((r) => normalize(r.repo_url) === target).map(toApp)
}

/** Replace the app's environment variables (whole-map replace, encrypted). */
export async function updateAppEnv(
  id: string,
  env: Record<string, string>,
): Promise<void> {
  const envEnc = Object.keys(env).length > 0 ? encryptJson(env) : null
  await query(
    'UPDATE hosting_apps SET env_encrypted = $2, updated_at = now() WHERE id = $1',
    [id, envEnc],
  )
}

export async function deleteApp(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM hosting_apps WHERE id = $1 RETURNING id',
    [id],
  )
  return rows.length > 0
}

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
