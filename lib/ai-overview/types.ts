/**
 * Client-safe контракт ответа ИИ-строки Обзора.
 *
 * Модель НИКОГДА не генерирует HTML или длинный markdown: каждый ответ — это
 * структурные данные одного из видов ниже, а клиент рендерит их красивыми
 * виджетами. Это одновременно экономит токены (модель выбирает интент, а не
 * пишет текст) и гарантирует единый вид ответов на всех уровнях каскада.
 *
 * NB: файл импортируется клиентскими компонентами — без server-only и БД.
 */

/** Строка-метрика в сводке ("Написали: 128 (+12 к прошлой неделе)"). */
export interface AnswerMetric {
  label: string
  value: string
  /** Дополнительная строка под значением (например, конверсия). */
  sub?: string
}

/** Табличный ответ: топ источников, сравнение и т.п. */
export interface AnswerTable {
  columns: string[]
  rows: (string | number)[][]
}

/** Отложенное изменение, требующее подтверждения кнопкой «Применить». */
export type PendingOverviewAction =
  | { type: 'rename_source'; sourceId: string; sourceName: string; newName: string }
  | { type: 'delete_source'; sourceId: string; sourceName: string }
  | {
      type: 'create_source'
      name: string
      channelIds: string[]
      channelNames: string[]
    }
  | {
      type: 'set_source_channels'
      sourceId: string
      sourceName: string
      channelIds: string[]
      channelNames: string[]
    }

/** Человекочитаемое описание отложенного действия для карточки подтверждения. */
export function describePendingAction(a: PendingOverviewAction): string {
  switch (a.type) {
    case 'rename_source':
      return `Переименовать источник «${a.sourceName}» в «${a.newName}»`
    case 'delete_source':
      return `Удалить источник «${a.sourceName}» целиком (вместе с финансами в «Учёте»)`
    case 'create_source':
      return a.channelNames.length > 0
        ? `Создать источник «${a.name}» с каналами: ${a.channelNames.join(', ')}`
        : `Создать источник «${a.name}» без каналов`
    case 'set_source_channels':
      return a.channelNames.length > 0
        ? `Каналы источника «${a.sourceName}»: ${a.channelNames.join(', ')}`
        : `Отвязать все каналы от источника «${a.sourceName}»`
  }
}

/** Структурный ответ ИИ-строки. Клиент рендерит виджет по kind. */
export type OverviewAnswer =
  | {
      kind: 'summary'
      title: string
      periodLabel: string
      metrics: AnswerMetric[]
    }
  | {
      kind: 'table'
      title: string
      periodLabel: string
      table: AnswerTable
    }
  | {
      /** Открыть карточку источника (клиент подсвечивает и раскрывает детали). */
      kind: 'open_source'
      title: string
      sourceId: string
    }
  | { kind: 'text'; title?: string; text: string }
  | {
      kind: 'confirm'
      title: string
      description: string
      action: PendingOverviewAction
    }

/** Итог одного запроса к строке. level — какой уровень каскада ответил. */
export interface OverviewAiResult {
  ok: boolean
  answer?: OverviewAnswer
  message?: string
  /** 1 — детерминированный интент, 2 — LLM-роутер, 3 — полный агент. */
  level: 1 | 2 | 3
}

/** Реплика истории строки (для уточняющих вопросов агента). */
export interface OverviewTurn {
  role: 'user' | 'assistant'
  content: string
}
