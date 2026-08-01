import type { LucideIcon } from 'lucide-react'
import {
  BellRing,
  BookOpen,
  BrainCircuit,
  FileDown,
  Flame,
  FlaskConical,
  GraduationCap,
  Highlighter,
  ListChecks,
  MessagesSquare,
  NotebookPen,
  Power,
  ScrollText,
  Settings2,
} from 'lucide-react'
import type { ConsoleIntent } from '@/lib/ai-console/intents'
import type {
  AssistantReport,
  AssistantResult,
  ExecutedAction,
  PendingConfirmation,
} from '@/lib/ai-console/assistant'
import type { ConsolePreset } from '@/lib/ai-console/presets'

/** Icon per panel for the inline-panel header and the quick-access chips. */
export const PANEL_ICON: Record<ConsoleIntent, LucideIcon> = {
  settings: Settings2,
  aggressiveness: Flame,
  knowledge: BookOpen,
  training: GraduationCap,
  corrections: Highlighter,
  dialogs: MessagesSquare,
  logs: ScrollText,
  help: BrainCircuit,
}

/** Icon per executed-action receipt category. */
export const ACTION_ICON: Record<ExecutedAction['kind'], LucideIcon> = {
  enabled: Power,
  tone: BrainCircuit,
  persona: Settings2,
  aggressiveness: Flame,
  model: Settings2,
  knowledge: BookOpen,
  lesson: GraduationCap,
  directive: ScrollText,
  followup: BellRing,
  dialog: MessagesSquare,
  report: FileDown,
  memory: NotebookPen,
  check: ListChecks,
  experiment: FlaskConical,
}

/** Human tone labels for the status strip. */
export const TONE_LABEL: Record<string, string> = {
  professional: 'Деловой',
  friendly: 'Дружелюбный',
  persuasive: 'Убедительный',
}

/** One rendered turn in the conversation. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  actions?: ExecutedAction[]
  openPanel?: ConsoleIntent | null
  source?: AssistantResult['source']
  /** A guarded change awaiting the admin's Confirm/Cancel (rendered as a card). */
  pending?: PendingConfirmation | null
  /** A downloadable report produced this turn (rendered as a download button). */
  report?: AssistantReport | null
  /** A high-impact preset awaiting confirmation (rendered as a card). */
  presetConfirm?: ConsolePreset | null
  /** True while tokens are still streaming into this bubble. */
  streaming?: boolean
}
