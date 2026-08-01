/**
 * Client-safe contract for the conversational "Серверы" assistant. The admin
 * talks to it in natural language ("давай добавим сервер", "вот репозиторий и
 * домен — запускай установку") and it can LIST/EXPLAIN the fleet, open a SECURE
 * credential form (secrets are entered client-side, never through the LLM),
 * create apps, and launch the autonomous deploy agent whose live output streams
 * back into the chat.
 *
 * Dependency-free (no `server-only`, no DB, no AI SDK) so the client console and
 * the server run-assistant share the exact same types.
 */

import type { ServerAuthType } from '@/lib/types'

/** One turn in the assistant conversation. */
export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

/** A hands-on panel the console opens inline below the message. */
export type OpenPanel =
  | { kind: 'servers' }
  | { kind: 'server'; id: string }
  | { kind: 'app'; id: string; serverId: string }

/**
 * A concrete change the assistant performed this turn, surfaced as a small
 * "receipt" chip so the admin always sees what actually happened.
 */
export interface ExecutedAction {
  kind:
    | 'server_created'
    | 'app_created'
    | 'deploy_started'
    | 'lifecycle'
    | 'app_deleted'
    | 'server_deleted'
    | 'info'
  /** Short human summary, e.g. «Запустил ИИ-установку intranet». */
  label: string
}

/**
 * A SECURE form the UI must render so the admin can enter a secret the LLM must
 * never see (an SSH private key / password, or a GitHub token). The assistant
 * pre-fills the non-secret fields it already gathered in conversation; the
 * secret itself is submitted straight to a server action, bypassing the model.
 */
export interface CredentialRequest {
  /** Which secret the form collects. */
  kind: 'server' | 'repo_token'
  /* --- server onboarding (kind='server') --- */
  name?: string
  ipAddress?: string
  sshPort?: number
  sshUsername?: string
  authType?: ServerAuthType
  /* --- private repo token (kind='repo_token') --- */
  appId?: string
  repoUrl?: string
  /** One-line human hint shown above the form. */
  note?: string
}

/**
 * An autonomous deploy the assistant just launched. The UI embeds a LIVE log
 * viewer for `deploymentId` so the admin watches the agent analyse the box,
 * install everything and bring the site up — step by step, in real time.
 */
export interface LaunchedDeploy {
  deploymentId: string
  appId: string
  appName: string
  serverName: string
  repoUrl: string
  domain: string | null
}

/** The full result of one assistant turn, consumed by the console UI. */
export interface AssistantResult {
  /** Natural-language answer shown as the assistant message. */
  reply: string
  /** Mutations the assistant performed this turn (may be empty). */
  actions: ExecutedAction[]
  /** Hands-on panel to open inline, or null. */
  openPanel: OpenPanel | null
  /** A secure secret-entry form to render, or null. */
  credentialRequest: CredentialRequest | null
  /** A live autonomous deploy to tail, or null. */
  launchedDeploy: LaunchedDeploy | null
  /** Whether this turn changed server/app/deploy data (UI refetches when true). */
  dataChanged: boolean
  /** Which engine answered: the tool-calling agent or the offline fallback. */
  source: 'ai' | 'fallback'
}

/** Max turns of history sent to the model (bounds latency + cost). */
export const ASSISTANT_HISTORY_LIMIT = 12
