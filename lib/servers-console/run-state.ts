import 'server-only'
import type {
  CredentialRequest,
  ExecutedAction,
  LaunchedDeploy,
  OpenPanel,
} from './assistant'

/**
 * Per-turn mutable state shared by every servers-console tool. Each tool is a
 * factory that closes over ONE RunState per turn; receipts (`actions`), the
 * panel to open, the secure credential form to render and the launched deploy
 * all accumulate here while the agent loops, and `finalize` reads them out.
 */
export type RunState = {
  actions: ExecutedAction[]
  openPanel: OpenPanel | null
  credentialRequest: CredentialRequest | null
  launchedDeploy: LaunchedDeploy | null
  dataChanged: boolean
}

/** Fresh state for one assistant turn. */
export function createRunState(): RunState {
  return {
    actions: [],
    openPanel: null,
    credentialRequest: null,
    launchedDeploy: null,
    dataChanged: false,
  }
}

/** Derive a short app name from a repo URL, e.g. ".../acme/intranet.git" → "intranet". */
export function appNameFromRepo(repoUrl: string): string {
  const cleaned = repoUrl
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
  const last = cleaned.split(/[/:]/).filter(Boolean).pop() ?? 'app'
  const slug = last.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
  return slug.replace(/^-|-$/g, '') || 'app'
}
