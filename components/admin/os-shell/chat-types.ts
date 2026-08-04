import type {
  AssistantReport,
  AssistantResult,
  DataView,
  ExecutedAction,
  PendingConfirmation,
} from '@/lib/admin-console/assistant'

/** One rendered message in the shell feed. */
export interface ShellMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** True while SSE deltas are still arriving. */
  streaming?: boolean
  /** Live tool-progress line («Ищу диалоги…») shown while streaming. */
  status?: string
  /** Receipts for the mutations performed during this turn. */
  actions?: ExecutedAction[]
  /** Structured data panels rendered under the reply. */
  views?: DataView[]
  /** Guarded action awaiting the admin's explicit click. */
  pending?: PendingConfirmation | null
  /** Downloadable report generated this turn. */
  report?: AssistantReport | null
}

/**
 * Meta frame of an SSE turn. `reply` is included as a safety net: if no delta
 * frames arrived (buffered proxy, offline fallback) the client renders it.
 */
export type ShellMeta = Omit<AssistantResult, 'reply'> & { reply?: string }

let counter = 0
/** Unique-enough id for optimistic message rendering. */
export function nextMessageId(): string {
  counter += 1
  return `${Date.now().toString(36)}-${counter}`
}
