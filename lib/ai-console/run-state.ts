import 'server-only'
import { getAiAssistSettings } from '@/lib/data/ai-assist'
import type { ConsoleIntent } from './intents'
import type {
  AssistantReport,
  ExecutedAction,
  PendingConfirmation,
} from './assistant'

/**
 * Per-turn mutable state shared by every co-pilot tool. The tool modules are
 * plain factories that close over ONE RunState instance per assistant turn:
 * receipts (`actions`), the guarded-action confirmation (`pending`), the panel
 * to open, the downloadable report and the settings-changed flag all accumulate
 * here while the agent loops, and `finalize` in run-assistant.ts reads them out.
 *
 * A single mutable object (rather than setters per field) is deliberate: it is
 * exactly the closure the tools shared when they lived in one file, so the
 * split cannot change behaviour.
 */

/** Pre-turn settings snapshot used to build one-click revert patches. */
export type SettingsBaseline = Awaited<ReturnType<typeof getAiAssistSettings>>

export type RunState = {
  actions: ExecutedAction[]
  openPanel: ConsoleIntent | null
  settingsChanged: boolean
  pending: PendingConfirmation | null
  report: AssistantReport | null
  baseline: SettingsBaseline
}

/** Fresh state for one assistant turn, with the revert baseline captured. */
export async function createRunState(): Promise<RunState> {
  return {
    actions: [],
    openPanel: null,
    settingsChanged: false,
    pending: null,
    report: null,
    baseline: await getAiAssistSettings(),
  }
}

/** Shorten a string for a receipt-chip label, adding an ellipsis if cut. */
export function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** Russian plural for "правило" (rule) by count: 1 правило, 2 правила, 5 правил. */
export function pluralRules(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'правило'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'правила'
  return 'правил'
}
