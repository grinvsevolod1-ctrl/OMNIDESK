import 'server-only'

/**
 * Доступ к конфигурации ИИ-автопилота (одна строка god_ai_config, id = 1).
 * Изолированная godовая подсистема (AGENTS.md §4).
 */

import { query } from '@/lib/db'
import type { AutopilotConfig } from './types'

interface ConfigRow {
  enabled: boolean
  topic: string
  channel_ids: unknown
  work_start_min: number
  work_end_min: number
  daily_target: number
  max_turns: number
  reply_enabled: boolean
  model: string | null
  updated_at: string | Date | null
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

function rowToConfig(row: ConfigRow): AutopilotConfig {
  return {
    enabled: row.enabled,
    topic: row.topic ?? '',
    channelIds: toStringArray(row.channel_ids),
    workStartMin: row.work_start_min,
    workEndMin: row.work_end_min,
    dailyTarget: row.daily_target,
    maxTurns: row.max_turns,
    replyEnabled: row.reply_enabled,
    model: row.model,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

/** Дефолт, если строки почему-то нет (миграция не применена). */
const DEFAULT_CONFIG: AutopilotConfig = {
  enabled: false,
  topic: '',
  channelIds: [],
  workStartMin: 600,
  workEndMin: 1320,
  dailyTarget: 5,
  maxTurns: 8,
  replyEnabled: true,
  model: null,
  updatedAt: null,
}

/** Прочитать конфигурацию автопилота. */
export async function getAutopilotConfig(): Promise<AutopilotConfig> {
  const rows = await query<ConfigRow>(
    `SELECT enabled, topic, channel_ids, work_start_min, work_end_min,
            daily_target, max_turns, reply_enabled, model, updated_at
       FROM god_ai_config WHERE id = 1 LIMIT 1`,
  )
  if (!rows[0]) return { ...DEFAULT_CONFIG }
  return rowToConfig(rows[0])
}

/** Частичное обновление конфигурации; возвращает свежую строку. */
export async function updateAutopilotConfig(
  patch: Partial<Omit<AutopilotConfig, 'updatedAt'>>,
): Promise<AutopilotConfig> {
  // Собираем UPDATE только из переданных полей (никакой интерполяции в SQL).
  const sets: string[] = []
  const values: unknown[] = []
  let i = 1
  const add = (col: string, val: unknown) => {
    sets.push(`${col} = $${i++}`)
    values.push(val)
  }

  if (patch.enabled !== undefined) add('enabled', patch.enabled)
  if (patch.topic !== undefined) add('topic', patch.topic)
  if (patch.channelIds !== undefined) add('channel_ids', JSON.stringify(patch.channelIds))
  if (patch.workStartMin !== undefined) add('work_start_min', patch.workStartMin)
  if (patch.workEndMin !== undefined) add('work_end_min', patch.workEndMin)
  if (patch.dailyTarget !== undefined) add('daily_target', patch.dailyTarget)
  if (patch.maxTurns !== undefined) add('max_turns', patch.maxTurns)
  if (patch.replyEnabled !== undefined) add('reply_enabled', patch.replyEnabled)
  if (patch.model !== undefined) add('model', patch.model)

  if (sets.length === 0) return getAutopilotConfig()

  sets.push('updated_at = now()')
  const rows = await query<ConfigRow>(
    `UPDATE god_ai_config SET ${sets.join(', ')} WHERE id = 1
     RETURNING enabled, topic, channel_ids, work_start_min, work_end_min,
               daily_target, max_turns, reply_enabled, model, updated_at`,
    values,
  )
  if (!rows[0]) return { ...DEFAULT_CONFIG, ...patch }
  return rowToConfig(rows[0])
}
