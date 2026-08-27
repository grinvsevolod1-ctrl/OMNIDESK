'use server'

/**
 * Server actions ИИ-автопилота god-мессенджера («ИИ в чатах»).
 *
 * ИЗОЛЯЦИЯ (AGENTS.md §4): под тем же гейтом assertConsoleOrMessenger, что и
 * остальные messenger-actions, и НЕ пишут в admin-видимый журнал аудита.
 * Обычная админка / Admin AI о них не знают.
 */

import {
  getAutopilotConfig,
  updateAutopilotConfig,
} from '@/lib/god-autopilot/config'
import { runAutopilotTick } from '@/lib/god-autopilot/runtime'
import type { AutopilotConfig } from '@/lib/god-autopilot/types'
import { assertConsoleOrMessenger, type ActionResult } from './shared'

export interface AutopilotConfigResult extends ActionResult {
  config?: AutopilotConfig
}

export interface AutopilotRunResult extends ActionResult {
  planned?: number
  created?: number
  replied?: number
}

const DAY_MIN = 0
const DAY_MAX = 24 * 60

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** Прочитать текущую конфигурацию автопилота. */
export async function secretGetAutopilotConfigAction(): Promise<AutopilotConfigResult> {
  await assertConsoleOrMessenger()
  try {
    const config = await getAutopilotConfig()
    return { ok: true, message: '', config }
  } catch (err) {
    console.warn('[god-autopilot] get config failed:', err)
    return { ok: false, message: 'Не удалось загрузить настройки ИИ' }
  }
}

/**
 * Сохранить настройки автопилота (из диалога настройки). Валидирует и
 * зажимает все числовые поля; тематику ограничивает разумной длиной.
 */
export async function secretSaveAutopilotConfigAction(input: {
  enabled?: boolean
  topic?: string
  channelIds?: string[]
  workStartMin?: number
  workEndMin?: number
  dailyTarget?: number
  maxTurns?: number
  replyEnabled?: boolean
  model?: string | null
}): Promise<AutopilotConfigResult> {
  await assertConsoleOrMessenger()

  const patch: Partial<Omit<AutopilotConfig, 'updatedAt'>> = {}

  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled)
  if (input.replyEnabled !== undefined) patch.replyEnabled = Boolean(input.replyEnabled)

  if (input.topic !== undefined) {
    const topic = String(input.topic).slice(0, 8000)
    patch.topic = topic
  }

  if (input.channelIds !== undefined) {
    const ids = Array.isArray(input.channelIds)
      ? input.channelIds.filter((v): v is string => typeof v === 'string').slice(0, 50)
      : []
    patch.channelIds = ids
  }

  let start = input.workStartMin !== undefined ? clampInt(input.workStartMin, DAY_MIN, DAY_MAX, 600) : undefined
  let end = input.workEndMin !== undefined ? clampInt(input.workEndMin, DAY_MIN, DAY_MAX, 1320) : undefined
  // Если заданы оба и окно вырождено/перевёрнуто — чиним.
  if (start !== undefined && end !== undefined && end <= start) {
    end = Math.min(DAY_MAX, start + 60)
  }
  if (start !== undefined) patch.workStartMin = start
  if (end !== undefined) patch.workEndMin = end

  if (input.dailyTarget !== undefined) patch.dailyTarget = clampInt(input.dailyTarget, 0, 200, 5)
  if (input.maxTurns !== undefined) patch.maxTurns = clampInt(input.maxTurns, 1, 40, 8)

  if (input.model !== undefined) {
    const m = input.model === null ? null : String(input.model).trim().slice(0, 120)
    patch.model = m && m.length > 0 ? m : null
  }

  // Нельзя включить без тематики и хотя бы одного канала.
  if (patch.enabled) {
    const next = { ...(await getAutopilotConfig()), ...patch }
    if (!next.topic.trim())
      return { ok: false, message: 'Опишите тематику, прежде чем включать ИИ' }
    if (next.channelIds.length === 0)
      return { ok: false, message: 'Выберите хотя бы один канал' }
  }

  try {
    const config = await updateAutopilotConfig(patch)
    return { ok: true, message: 'Настройки ИИ сохранены', config }
  } catch (err) {
    console.warn('[god-autopilot] save config failed:', err)
    return { ok: false, message: 'Не удалось сохранить настройки ИИ' }
  }
}

/** Быстрый тумблер включения/выключения (кнопка в шапке). */
export async function secretToggleAutopilotAction(
  enabled: boolean,
): Promise<AutopilotConfigResult> {
  return secretSaveAutopilotConfigAction({ enabled: Boolean(enabled) })
}

/**
 * Ручной прогон автопилота («Прогнать сейчас»). Тот же tick, что дёргает крон,
 * но по кнопке — удобно проверить настройки не дожидаясь расписания.
 */
export async function secretRunAutopilotNowAction(): Promise<AutopilotRunResult> {
  await assertConsoleOrMessenger()
  try {
    const res = await runAutopilotTick({ maxCreate: 3, maxReplies: 10, force: true })
    if (res.skipped === 'disabled')
      return { ok: false, message: 'ИИ выключен' }
    if (res.skipped === 'no_channels')
      return { ok: false, message: 'Не выбран ни один канал' }
    if (res.skipped === 'no_gateway_key')
      return {
        ok: false,
        message: 'Не настроен ключ AI Gateway (AI_GATEWAY_API_KEY) на сервере',
      }
    if (res.skipped === 'no_usable_channel')
      return {
        ok: false,
        message: 'У выбранных каналов нет назначенного менеджера',
      }
    if (res.skipped === 'generation_failed')
      return {
        ok: false,
        message: 'Модель не ответила: проверьте ключ AI Gateway и название модели',
      }
    return {
      ok: true,
      message: `Готово: создано ${res.created}, ответов ${res.replied}`,
      planned: res.planned,
      created: res.created,
      replied: res.replied,
    }
  } catch (err) {
    console.warn('[god-autopilot] manual run failed:', err)
    return { ok: false, message: 'Прогон не удался' }
  }
}
