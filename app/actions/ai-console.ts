'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  getAiAssistSettings,
  updateAiAssistSettings,
  listKnowledge,
  countLessons,
} from '@/lib/data/ai-assist'
import { listAiLogs, getAiWeeklyStats } from '@/lib/data/ai-log'
import {
  AGGRESSIVENESS_LABELS,
  type AssistantResult,
  type AssistantTurn,
  type AiWeeklyStats,
  type ConsoleBriefing,
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
 * server-action surface plus the proactive briefing, weekly summary, presets,
 * confirmation of guarded actions and one-click undo.
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
 * Proactive health check shown the moment the console opens. Deterministic —
 * reads live data and surfaces what needs attention with one-click fixes. Never
 * calls the model, so it works even without a gateway. Strictly AI-manager
 * scope; log reads are hard-scoped to 'ai' (the secret simulator can't leak in).
 */
export async function aiConsoleBriefingAction(): Promise<ConsoleBriefing> {
  await requireAdmin()

  const [settings, knowledge, lessonCount, errorLogs] = await Promise.all([
    getAiAssistSettings(),
    listKnowledge(),
    countLessons(),
    listAiLogs({ scope: 'ai', level: 'error', limit: 200 }),
  ])

  // Errors within the last 24h — the window an admin actually cares about.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000
  const errorsToday = errorLogs.filter(
    (l) => new Date(l.createdAt).getTime() >= dayAgo,
  ).length

  const issues: ConsoleBriefing['issues'] = []

  if (!settings.enabled) {
    issues.push({
      severity: 'warn',
      text: 'ИИ-менеджер выключен — клиенты сейчас не получают автоответы.',
      action: 'Включи ИИ-менеджера',
    })
  }
  if (errorsToday > 0) {
    issues.push({
      severity: 'warn',
      text: `За сутки ${errorsToday} ${pluralErrors(errorsToday)} ИИ — стоит разобраться.`,
      action: 'Что с ошибками ИИ?',
    })
  }
  if (knowledge.length === 0) {
    issues.push({
      severity: 'info',
      text: 'База знаний пустая — ИИ отвечает без фактов о вашей компании.',
      action: 'Добавь факт про доставку и оплату',
    })
  }
  if (lessonCount === 0) {
    issues.push({
      severity: 'info',
      text: 'Пока нет ни одного урока — ИИ не дообучен на ваших диалогах.',
      action: 'Открой обучение ассистента',
    })
  }

  const healthy = issues.length === 0
  const aggr =
    AGGRESSIVENESS_LABELS[settings.aggressiveness]?.toLowerCase() ??
    'сбалансированный'
  const headline = healthy
    ? `Всё работает штатно: ИИ включён, дожим ${aggr}. Чем помочь?`
    : issues.length === 1
      ? 'Одна вещь требует внимания:'
      : `${issues.length} ${pluralPoints(issues.length)} требуют внимания:`

  return { headline, issues, healthy }
}

/**
 * A 7-day activity snapshot of the AI manager for the weekly summary card.
 * Deterministic, AI-scoped, best-effort (returns zeros if the log is empty).
 */
export async function aiWeeklySummaryAction(): Promise<AiWeeklyStats> {
  await requireAdmin()
  return getAiWeeklyStats()
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

/** Russian plural for the error counter. */
function pluralErrors(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'ошибка'
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'ошибки'
  return 'ошибок'
}

/** Russian plural for the "N points need attention" headline. */
function pluralPoints(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'пункт'
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return 'пункта'
  return 'пунктов'
}
