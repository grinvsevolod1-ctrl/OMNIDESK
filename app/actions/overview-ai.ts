'use server'

/**
 * Server actions ИИ-строки Обзора.
 *
 * ask — прогоняет вопрос через каскад (уровни 1→2→3, run-overview-ai).
 * confirm — исполняет отложенное действие ПОСЛЕ кнопки «Применить»:
 *   ни одного токена — чистый CRUD через канонические функции источников.
 *
 * Rate-limit: 10 запросов/мин на процесс — строка не должна позволять
 * случайно сжечь бюджет токенов зажатой клавишей Enter.
 */

import { requireAdmin } from '@/lib/auth'
import {
  createSource,
  deleteSource,
  updateSource,
} from '@/lib/data/sources'
import { runOverviewAi, type OverviewAiOptions } from '@/lib/ai-overview/run-overview-ai'
import type {
  OverviewAiResult,
  PendingOverviewAction,
} from '@/lib/ai-overview/types'
import { revalidatePath } from 'next/cache'

/* Простой in-memory лимитер (тот же подход, что у AI-отчётов). */
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 10
let windowStart = 0
let windowCount = 0

function rateLimited(): boolean {
  const now = Date.now()
  if (now - windowStart > WINDOW_MS) {
    windowStart = now
    windowCount = 0
  }
  windowCount++
  return windowCount > MAX_PER_WINDOW
}

export async function askOverviewAiAction(
  question: string,
  opts: OverviewAiOptions,
): Promise<OverviewAiResult> {
  await requireAdmin()
  if (rateLimited()) {
    return {
      ok: false,
      level: 1,
      message: 'Слишком много запросов подряд — подождите минуту.',
    }
  }
  const q = (question ?? '').trim().slice(0, 500)
  try {
    return await runOverviewAi(q, opts)
  } catch {
    return {
      ok: false,
      level: 1,
      message: 'Не удалось обработать запрос. Попробуйте ещё раз.',
    }
  }
}

export interface ConfirmResult {
  ok: boolean
  message: string
}

/** Исполнение подтверждённого действия — без модели, чистый CRUD. */
export async function confirmOverviewActionAction(
  action: PendingOverviewAction,
): Promise<ConfirmResult> {
  await requireAdmin()
  try {
    switch (action.type) {
      case 'rename_source': {
        await updateSource(action.sourceId, { name: action.newName })
        revalidatePath('/admin')
        return { ok: true, message: `Источник переименован в «${action.newName}».` }
      }
      case 'delete_source': {
        await deleteSource(action.sourceId)
        revalidatePath('/admin')
        return { ok: true, message: `Источник «${action.sourceName}» удалён.` }
      }
      case 'create_source': {
        await createSource(action.name, action.channelIds)
        revalidatePath('/admin')
        return { ok: true, message: `Источник «${action.name}» создан.` }
      }
      case 'set_source_channels': {
        await updateSource(action.sourceId, { channelIds: action.channelIds })
        revalidatePath('/admin')
        return { ok: true, message: `Каналы источника «${action.sourceName}» обновлены.` }
      }
      default:
        return { ok: false, message: 'Неизвестное действие.' }
    }
  } catch {
    return { ok: false, message: 'Не удалось выполнить действие.' }
  }
}
