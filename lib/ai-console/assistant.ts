/**
 * Client-safe contract for the conversational admin assistant ("the AI-manager
 * co-pilot"). This is the Siri-like layer on top of the plain intent router:
 * the admin talks to it in natural language and it can EXPLAIN things, CHANGE
 * settings, ADD knowledge/lessons, and OPEN hands-on panels — all strictly
 * within the scope of the AI sales manager, and with ZERO awareness of the
 * secret client simulator (a separate god-panel feature).
 *
 * Kept dependency-free (no `server-only`, no DB, no AI SDK) so the client
 * console and the server agent share the exact same types.
 */

import type { ConsoleIntent } from './intents'

/** One turn in the assistant conversation. */
export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

/**
 * A revertible settings patch. Only settings mutations can be undone — the
 * shape mirrors the `updateAiAssistSettings` patch so the revert action can
 * apply it verbatim to restore the previous value. Content additions
 * (knowledge/lessons) are intentionally not auto-revertible.
 */
export interface SettingsRevert {
  enabled?: boolean
  tone?: string
  persona?: string
  aggressiveness?: number
  temperature?: number
  maxTokens?: number
  model?: string
}

/**
 * A concrete change the assistant performed during a turn, surfaced in the UI as
 * a small "receipt" chip so the admin always sees what actually happened.
 */
export interface ExecutedAction {
  /** Category — drives the icon shown next to the receipt. */
  kind:
    | 'enabled'
    | 'tone'
    | 'persona'
    | 'aggressiveness'
    | 'model'
    | 'knowledge'
    | 'lesson'
  /** Short human summary, e.g. «Включил ИИ» or «Агрессивность → Максимум». */
  label: string
  /**
   * When present, the UI shows an «Отменить» button that restores the previous
   * value by applying this patch. Only settings mutations carry it.
   */
  revert?: SettingsRevert
}

/** The full result of one assistant turn, consumed by the console UI. */
export interface AssistantResult {
  /** Natural-language answer to show as the assistant message. */
  reply: string
  /** Mutations the assistant performed this turn (may be empty). */
  actions: ExecutedAction[]
  /**
   * If set, the UI opens this hands-on panel inline below the message — used for
   * tasks better done by hand (enrolling dialogs, message-level corrections,
   * browsing logs, deep training).
   */
  openPanel: ConsoleIntent | null
  /**
   * Whether this turn actually touched AI-manager settings — the UI refetches
   * fresh settings when true so the open panels stay in sync.
   */
  settingsChanged: boolean
  /**
   * A high-impact change the assistant deliberately did NOT apply, and is asking
   * the admin to confirm first (turning the AI off, or maxing out aggression).
   * When present, the UI shows a Confirm/Cancel card instead of a silent change.
   */
  pending?: PendingConfirmation | null
  /** Which engine answered: the tool-calling agent or the offline fallback. */
  source: 'ai' | 'fallback'
}

/**
 * A guarded, high-impact action the assistant proposes but won't run until the
 * admin explicitly confirms it. Executed via aiConfirmPendingAction.
 */
export interface PendingConfirmation {
  kind: 'disable' | 'max_aggressiveness'
  /** Button/label text, e.g. «Выключить ИИ-менеджера». */
  label: string
  /** One-sentence consequence so the admin knows what they're approving. */
  detail: string
}

/** Max turns of history we send to the model (keeps latency + cost bounded). */
export const ASSISTANT_HISTORY_LIMIT = 12

/** Human labels for the four aggressiveness levels (shared UI + agent). */
export const AGGRESSIVENESS_LABELS = [
  'Мягкий',
  'Сбалансированный',
  'Напористый',
  'Максимальный дожим',
] as const
