/* --------------------------- App Hosting ("Серверы") --------------------------- */

/** How the worker authenticates over SSH to a managed server. */
export type ServerAuthType = 'ssh_key' | 'password'
/** Health state of a managed server, driven by the worker's health checks. */
export type ServerStatus = 'online' | 'offline' | 'unknown'
/** Detected/declared runtime that decides the deploy pipeline for an app. */
export type AppRuntime = 'node' | 'docker' | 'static' | 'php'
/** Lifecycle of a deployed application. */
export type AppStatus = 'stopped' | 'building' | 'running' | 'error'
/** Lifecycle of a single deploy attempt. */
export type DeploymentStatus =
  | 'queued'
  | 'cloning'
  | 'building'
  | 'running'
  | 'success'
  | 'failed'
/**
 * Which stream a deploy log line came from. Beyond process output we also
 * record the autonomous agent's own activity:
 *   - 'agent'   — the model's reasoning / narration of what it's about to do
 *   - 'command' — a shell command the agent decided to run (echoed before output)
 */
export type DeployLogStream =
  | 'stdout'
  | 'stderr'
  | 'system'
  | 'agent'
  | 'command'
/** Command the panel enqueues for the hosting worker to run over SSH. */
export type DeployAction =
  | 'deploy'
  | 'start'
  | 'stop'
  | 'restart'
  | 'remove'
  | 'health_check'
  /** Autonomous AI deploy: the agent analyses the box and installs everything. */
  | 'ai_deploy'
  /** Restore the pre-redeploy snapshot (<appDir>.prev) and restart. */
  | 'rollback'
/** How a deployment was carried out. */
export type DeploymentMode = 'manual' | 'ai'

/** Latest resource snapshot the worker records for a server. */
export interface ServerMetrics {
  /** CPU load as a percentage (0–100), or null when unknown. */
  cpu: number | null
  /** Memory used as a percentage (0–100), or null when unknown. */
  mem: number | null
  /** Disk used as a percentage (0–100), or null when unknown. */
  disk: number | null
  /** Human-readable uptime string (e.g. "up 5 days"), or null. */
  uptime: string | null
}

export interface HostingServer {
  id: string
  name: string
  ipAddress: string
  sshPort: number
  authType: ServerAuthType
  sshUsername: string
  /** True when SSH credentials are stored (the secret itself stays encrypted). */
  hasSecret: boolean
  /** True once the SSH host key has been pinned on first connect. */
  hostKeyPinned: boolean
  status: ServerStatus
  metrics: ServerMetrics
  lastError: string | null
  lastCheckedAt: string | null
  createdAt: string
  /** Number of apps deployed on this server (list views only). */
  appCount?: number
}

export interface HostingApp {
  id: string
  serverId: string
  name: string
  repoUrl: string
  branch: string
  domain: string | null
  runtime: AppRuntime
  /** Environment variable KEYS only — values stay encrypted and are never sent. */
  envKeys: string[]
  port: number | null
  status: AppStatus
  lastError: string | null
  /** True when a GitHub token is stored for cloning a private repo (masked). */
  hasRepoToken: boolean
  /** Redeploy automatically on GitHub push to the tracked branch. */
  autoDeploy: boolean
  createdAt: string
  updatedAt: string
}

export interface HostingDeployment {
  id: string
  appId: string
  commitHash: string | null
  status: DeploymentStatus
  trigger: string
  /** Whether this deploy ran via the classic pipeline or the autonomous agent. */
  mode: DeploymentMode
  /** Agent's closing summary of what it did (AI deploys), or null. */
  summary: string | null
  /** Resolved public URL once the deploy succeeded, or null. */
  siteUrl: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface HostingDeployLog {
  id: number
  deploymentId: string
  seq: number
  stream: DeployLogStream
  line: string
  createdAt: string
}
