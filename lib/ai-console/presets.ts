/**
 * One-click "modes" for the AI sales manager. Each preset is a small bundle of
 * settings the admin can apply in a single tap instead of tweaking fields one
 * by one. Client-safe (no server imports): the console renders these, and the
 * server action re-derives the same patch from the id when applying, so the two
 * can never drift.
 */

import { AGGRESSIVENESS_LABELS } from './assistant'

export type PresetId = 'careful' | 'standard' | 'sale' | 'closer'

/** The settings a preset applies. Only listed fields change. */
export interface PresetPatch {
  tone: 'professional' | 'friendly' | 'persuasive'
  aggressiveness: number
}

export interface ConsolePreset {
  id: PresetId
  /** Short button label. */
  name: string
  /** One line explaining when to use it. */
  description: string
  patch: PresetPatch
  /**
   * High-impact presets (maximum pressure) ask for confirmation before applying,
   * exactly like the guarded agent actions.
   */
  confirm?: boolean
}

export const CONSOLE_PRESETS: ConsolePreset[] = [
  {
    id: 'careful',
    name: 'Бережный',
    description: 'Мягкий тон, минимум давления — для тёплой, аккуратной работы.',
    patch: { tone: 'friendly', aggressiveness: 1 },
  },
  {
    id: 'standard',
    name: 'Стандартный',
    description: 'Деловой тон, сбалансированный дожим — универсальный режим.',
    patch: { tone: 'professional', aggressiveness: 2 },
  },
  {
    id: 'sale',
    name: 'Распродажа',
    description: 'Убедительный тон, напористый дожим — когда нужно больше заявок.',
    patch: { tone: 'persuasive', aggressiveness: 2 },
  },
  {
    id: 'closer',
    name: 'Максимальный дожим',
    description: 'Убедительный тон и предельный дожим до документов. Применять осознанно.',
    patch: { tone: 'persuasive', aggressiveness: 3 },
    confirm: true,
  },
]

/** Look up a preset by id (used by both the UI and the server action). */
export function getPreset(id: string): ConsolePreset | null {
  return CONSOLE_PRESETS.find((p) => p.id === id) ?? null
}

/** Human summary of what a preset does, e.g. for a receipt/toast. */
export function presetSummary(p: ConsolePreset): string {
  const toneLabel =
    p.patch.tone === 'professional'
      ? 'деловой'
      : p.patch.tone === 'friendly'
        ? 'дружелюбный'
        : 'убедительный'
  return `тон ${toneLabel}, дожим «${AGGRESSIVENESS_LABELS[p.patch.aggressiveness]}»`
}
