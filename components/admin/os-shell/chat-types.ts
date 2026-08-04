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
  /** Receipts for the mutations performed during this turn. */
  actions?: ExecutedAction[]
  /** Structured data panels rendered under the reply. */
  views?: DataView[]
  /** Guarded action awaiting the admin's explicit click. */
  pending?: PendingConfirmation | null
  /** Downloadable report generated this turn. */
  report?: AssistantReport | null
}

/** Meta portion of an SSE turn (AssistantResult minus the reply text). */
export type ShellMeta = Omit<AssistantResult, 'reply'>

let counter = 0
/** Unique-enough id for optimistic message rendering. */
export function nextMessageId(): string {
  counter += 1
  return `${Date.now().toString(36)}-${counter}`
}
