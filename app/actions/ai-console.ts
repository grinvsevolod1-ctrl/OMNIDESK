'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  getAiAssistSettings,
  updateAiAssistSettings,
} from '@/lib/data/ai-assist'
import { updateFollowupSettings } from '@/lib/data/ai-followup'
import { startExperiment, stopExperiment } from '@/lib/data/ai-experiments'
import { parseOverrides } from '@/lib/ai/experiment'
import {
  AGGRESSIVENESS_LABELS,
  type AssistantResult,
  type AssistantTurn,
  type ExecutedAction,
  type PendingConfirmation,
  type SettingsRevert,
} from '@/lib/ai-console/assistant'
import { getPreset } from '@/lib/ai-console/presets'
import { AI_PATH, runAssistantOnce } from '@/lib/ai-console/run-assistant'

/**
 * Server actions for the conversational co-pilot of the AI SALES MANAGER admin
 * panel. The heavy agent orchestration lives in `lib/ai-console/run-assistant`
 * (shared with the streaming route); this file exposes the thin, admin-guarded
 * server-action surface: the non-streaming fallback turn, presets, confirmation
 * of guarded actions and one-click undo.
 *
 * Hard guarantees preserved from the original design:
 *   1. Scope lock — zero knowledge of the secret client simulator.
 *   2. Never breaks — offline falls back to the deterministic keyword classifier.
 */

/**
 * Resolve one assistant turn (non-streaming). The streaming route is preferred
 * by the client; this remains the reliable fallback path and keeps the public
 * server-action contract stable.
 */
export async function aiAssistantAction(
  history: AssistantTurn[],
): Promise<AssistantResult> {
  await requireAdmin()
  return runAssistantOnce(history)
}

/**
 * Apply a one-click preset (a bundle of tone + aggressiveness). Returns the
 * receipts (with revert patches) so the console can show them and offer undo.
 * The «closer» preset is confirmed client-side before this is called.
 */
export async function aiApplyPresetAction(
  presetId: string,
): Promise<{ ok: boolean; actions: ExecutedAction[] }> {
  await requireAdmin()
  const preset = getPreset(presetId)
  if (!preset) return { ok: false, actions: [] }

  const baseline = await getAiAssistSettings()
  await updateAiAssistSettings({
    tone: preset.patch.tone,
    aggressiveness: preset.patch.aggressiveness,
  })
  revalidatePath(AI_PATH)

  const toneLabel =
    preset.patch.tone === 'professional'
      ? 'деловой'
      : preset.patch.tone === 'friendly'
        ? 'дружелюбный'
        : 'убедительный'
  const actions: ExecutedAction[] = [
    {
      kind: 'tone',
      label: `Тон → ${toneLabel}`,
      revert: { tone: baseline.tone },
    },
    {
      kind: 'aggressiveness',
      label: `Агрессивность → ${AGGRESSIVENESS_LABELS[preset.patch.aggressiveness]}`,
      revert: { aggressiveness: baseline.aggressiveness },
    },
  ]
  return { ok: true, actions }
}

/**
 * Execute a guarded action the admin just confirmed (disabling the AI or maxing
 * aggressiveness). Returns the receipt (with a revert patch) so the console can
 * show it and still offer one-click undo.
 */
export async function aiConfirmPendingAction(
  pending: PendingConfirmation,
): Promise<{ ok: boolean; action?: ExecutedAction }> {
  await requireAdmin()
  const baseline = await getAiAssistSettings()

  if (pending.kind === 'disable') {
    await updateAiAssistSettings({ enabled: false })
    revalidatePath(AI_PATH)
    return {
      ok: true,
      action: {
        kind: 'enabled',
        label: 'Выключил ИИ-менеджера',
        revert: { enabled: baseline.enabled },
      },
    }
  }
  if (pending.kind === 'max_aggressiveness') {
    await updateAiAssistSettings({ aggressiveness: 3 })
    revalidatePath(AI_PATH)
    return {
      ok: true,
      action: {
        kind: 'aggressiveness',
        label: `Агрессивность → ${AGGRESSIVENESS_LABELS[3]}`,
        revert: { aggressiveness: baseline.aggressiveness },
      },
    }
  }
  if (pending.kind === 'enable_followup') {
    await updateFollowupSettings({ enabled: true })
    revalidatePath(AI_PATH)
    return {
      ok: true,
      action: {
        kind: 'followup',
        label: 'Включил авто-дожим (follow-up)',
      },
    }
  }
  if (pending.kind === 'start_experiment') {
    // Re-validate the payload from scratch: it round-tripped through the
    // client, so it is untrusted input like any other.
    const p = pending.payload ?? {}
    const name = typeof p.name === 'string' ? p.name.trim() : ''
    const overrides = parseOverrides(p.overrides)
    if (
      !name ||
      (overrides.persona === undefined &&
        overrides.tone === undefined &&
        overrides.aggressiveness === undefined &&
        overrides.extraDirective === undefined)
    ) {
      return { ok: false }
    }
    const res = await startExperiment({ name, overrides })
    if (!res.ok) return { ok: false }
    revalidatePath(AI_PATH)
    return {
      ok: true,
      action: {
        kind: 'experiment',
        label: `Запустил эксперимент «${name.slice(0, 50)}» (А/Б 50/50)`,
      },
    }
  }
  if (pending.kind === 'adopt_experiment_winner') {
    // Stop the experiment, then promote branch B's overrides to the master
    // settings — same clamping as the assistant's own settings tools.
    const overrides = parseOverrides(pending.payload?.overrides)
    const stopped = await stopExperiment('B')
    if (!stopped.ok) return { ok: false }
    const patch: Parameters<typeof updateAiAssistSettings>[0] = {}
    if (overrides.persona?.trim()) patch.persona = overrides.persona.trim()
    if (overrides.tone?.trim()) patch.tone = overrides.tone.trim()
    if (typeof overrides.aggressiveness === 'number') {
      patch.aggressiveness = Math.max(
        0,
        Math.min(3, Math.round(overrides.aggressiveness)),
      )
    }
    if (Object.keys(patch).length > 0) await updateAiAssistSettings(patch)
    revalidatePath(AI_PATH)
    return {
      ok: true,
      action: {
        kind: 'experiment',
        label: `Принял вариант Б эксперимента «${stopped.experiment.name.slice(0, 50)}» как основной`,
        revert: {
          persona: baseline.persona,
          tone: baseline.tone,
          aggressiveness: baseline.aggressiveness,
        },
      },
    }
  }
  return { ok: false }
}

/**
 * Restore a settings value the assistant changed this session (the «Отменить»
 * button on an action receipt). Admin-only; mirrors the same clamping the agent
 * tools use, so a stale/odd revert patch fails soft.
 */
export async function aiRevertSettingsAction(
  revert: SettingsRevert,
): Promise<{ ok: boolean }> {
  await requireAdmin()
  const patch: SettingsRevert = {}
  if (typeof revert.enabled === 'boolean') patch.enabled = revert.enabled
  if (typeof revert.tone === 'string') patch.tone = revert.tone
  if (typeof revert.persona === 'string') patch.persona = revert.persona
  if (typeof revert.aggressiveness === 'number') {
    patch.aggressiveness = Math.max(0, Math.min(3, Math.round(revert.aggressiveness)))
  }
  if (typeof revert.temperature === 'number') {
    patch.temperature = Math.max(0, Math.min(2, revert.temperature))
  }
  if (typeof revert.maxTokens === 'number') {
    patch.maxTokens = Math.max(50, Math.min(4000, Math.round(revert.maxTokens)))
  }
  if (typeof revert.model === 'string') patch.model = revert.model
  if (Object.keys(patch).length === 0) return { ok: false }
  await updateAiAssistSettings(patch)
  revalidatePath(AI_PATH)
  return { ok: true }
}
