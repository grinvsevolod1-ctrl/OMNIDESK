/**
 * Типы ИИ-автопилота god-мессенджера. Изолированная godовая подсистема
 * (AGENTS.md §4) — обычная админка / Admin AI её не импортируют.
 */

/** Конфигурация автопилота (одна строка god_ai_config, id = 1). */
export interface AutopilotConfig {
  enabled: boolean
  /** Тематика: владелец пишет максимально подробно, ИИ строго ей следует. */
  topic: string
  /** id каналов, в которых создавать диалоги. */
  channelIds: string[]
  /** Рабочее окно в минутах от полуночи МСК. */
  workStartMin: number
  workEndMin: number
  /** Сколько новых диалогов создавать за день (в среднем). */
  dailyTarget: number
  /** Максимум клиентских реплик в одном диалоге. */
  maxTurns: number
  /** Продолжать ли отвечать менеджеру как клиент. */
  replyEnabled: boolean
  /** Переопределение модели AI Gateway (пусто → дефолт). */
  model: string | null
  updatedAt: string | null
}

/**
 * Персона «клиента» одного диалога. Собирается из пулов случайно (без ИИ),
 * поэтому каждый диалог гарантированно отличается по жанру/манере/цели, даже
 * когда тематика одна и та же.
 */
export interface AutopilotPersona {
  /** Отображаемое имя контакта. */
  name: string
  /** Хэндл контакта (id/username). */
  handle: string
  /** Город (иногда всплывает в разговоре, добавляет естественности). */
  city: string
  /** Архетип клиента (жанр диалога). */
  archetype: string
  /** Манера письма. */
  style: string
  /** Настроение/тон. */
  mood: string
  /** Что человек хочет по теме (его цель обращения). */
  goal: string
}

/** Итог одного прогона автопилота. */
export interface AutopilotTickResult {
  planned: number
  created: number
  replied: number
  skipped: string | null
}
