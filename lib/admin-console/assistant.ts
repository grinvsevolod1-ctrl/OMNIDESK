/**
 * Client-safe contract for the OMNIDESK OS shell copilot — the single command
 * field that wraps the ENTIRE admin panel (everything except the god-panel).
 * The admin talks to it in natural language; it can EXPLAIN, NAVIGATE, REPORT
 * and PERFORM any admin action. Dangerous actions are two-phase: the copilot
 * returns a `pending` confirmation instead of applying silently.
 *
 * Dependency-free (no `server-only`, no DB, no AI SDK): the shell UI and the
 * server agent share these exact types.
 */

import type { ShellSection } from './intents'

/** One turn in the shell conversation. */
export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

/** A concrete change performed this turn, shown as a "receipt" chip. */
export interface ExecutedAction {
  kind:
    | 'manager'
    | 'channel'
    | 'proxy'
    | 'finance'
    | 'dictionary'
    | 'navigation'
    | 'report'
    | 'schedule'
  /** Short human summary, e.g. «Заблокировал менеджера Ivan». */
  label: string
}

/**
 * A guarded, high-impact action the copilot proposes but will NOT run until
 * the admin explicitly confirms. Executed via confirmShellPendingAction.
 */
export interface PendingConfirmation {
  kind:
    | 'delete_manager'
    | 'block_manager'
    | 'delete_channel'
    | 'reassign_channel'
    | 'delete_proxy'
    | 'delete_finance_entry'
  /** Button text, e.g. «Удалить менеджера Ivan». */
  label: string
  /** One-sentence consequence so the admin knows what they're approving. */
  detail: string
  /** Parameters that survive the confirmation round-trip (validated again). */
  payload: Record<string, unknown>
}

/** A downloadable report generated this turn (client-side Blob download). */
export interface AssistantReport {
  filename: string
  mimeType: string
  content: string
  label: string
}

/**
 * A structured data panel the shell renders under the assistant message:
 * the copilot's way of SHOWING data instead of dumping it into prose.
 * `kind` selects the renderer; `payload` is renderer-specific JSON.
 */
export interface DataView {
  kind:
    | 'stats'
    | 'managers'
    | 'channels'
    | 'proxies'
    | 'contacts'
    | 'finance'
    | 'dictionaries'
    | 'schedules'
  title: string
  payload: unknown
}

/** The full result of one shell copilot turn. */
export interface AssistantResult {
  reply: string
  actions: ExecutedAction[]
  /** Section the admin should be taken to (classic route), if any. */
  openSection: ShellSection | null
  /** Structured data panels rendered under the reply. */
  views: DataView[]
  pending?: PendingConfirmation | null
  report?: AssistantReport | null
  source: 'ai' | 'fallback'
}

/** Max turns of history sent to the model (bounds latency + cost). */
export const ASSISTANT_HISTORY_LIMIT = 12

/** Cookie flag: '0' switches the admin panel back to the classic tab UI. */
export const SHELL_MODE_COOKIE = 'od_os_shell'
