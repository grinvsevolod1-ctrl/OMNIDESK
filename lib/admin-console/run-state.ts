import 'server-only'
import type { ShellSection } from './intents'
import type {
  AssistantReport,
  DataView,
  ExecutedAction,
  PendingConfirmation,
} from './assistant'

/**
 * Per-turn mutable state shared by every shell-copilot tool (same pattern as
 * lib/ai-console/run-state.ts): tool modules are factories closing over ONE
 * RunState per turn; `finalize` in run-assistant.ts reads it out.
 */
export type RunState = {
  actions: ExecutedAction[]
  openSection: ShellSection | null
  views: DataView[]
  pending: PendingConfirmation | null
  report: AssistantReport | null
}

export function createRunState(): RunState {
  return {
    actions: [],
    openSection: null,
    views: [],
    pending: null,
    report: null,
  }
}

/** Shorten a string for a receipt-chip label. */
export function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}
