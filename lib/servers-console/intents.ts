/**
 * Dependency-free intent contract for the "Серверы" AI console.
 *
 * Like the AI-manager console, the servers tab is a single natural-language
 * command box: the admin types what they want ("добавь сервер", "разверни репо
 * на проде", "покажи логи установки") and a router resolves it to one of these
 * intents. The catalogue is the single source of truth for chip labels, example
 * prompts and the offline keyword fallback used when the gateway is down.
 *
 * Client-safe: no `server-only`, no DB, no AI SDK — imported by BOTH the client
 * console and the server run-assistant.
 */

/** Every high-level thing the admin can ask the servers console for. */
export type ServersIntent =
  | 'servers' // show / manage the fleet
  | 'add_server' // onboard a new box
  | 'deploy' // deploy a repo to a server (autonomous agent)
  | 'logs' // watch install / deploy output
  | 'help'

/** Static description of one intent: how to show, match and prompt it. */
export interface IntentMeta {
  intent: ServersIntent
  label: string
  description: string
  examples: string[]
  /** Lowercase keyword stems for the deterministic fallback (substring match). */
  keywords: string[]
}

/** The catalogue. Order drives chip order and fallback tie-breaks. */
export const INTENT_CATALOGUE: IntentMeta[] = [
  {
    intent: 'add_server',
    label: 'Добавить сервер',
    description: 'Подключить новый VPS по SSH, чтобы ИИ мог им управлять',
    examples: [
      'Давай добавим сервер',
      'Подключи новый VPS',
      'Заведи сервер для проекта',
    ],
    keywords: [
      'добав',
      'подключ',
      'новый сервер',
      'завед',
      'vps',
      'впс',
      'создать сервер',
    ],
  },
  {
    intent: 'deploy',
    label: 'Развернуть проект',
    description: 'Дать ссылку на репозиторий и домен — ИИ сам всё установит',
    examples: [
      'Разверни этот репозиторий',
      'Запускай установку проекта',
      'Задеплой github на прод',
      'Установи сайт на сервер',
    ],
    keywords: [
      'деплой',
      'разверн',
      'установи',
      'запусти установ',
      'запускай установ',
      'выкат',
      'github',
      'гитхаб',
      'репозитор',
      'репо',
      'проект',
      'сайт',
      'домен',
    ],
  },
  {
    intent: 'servers',
    label: 'Мои серверы',
    description: 'Список серверов, их состояние и приложения',
    examples: [
      'Покажи мои серверы',
      'Что с нагрузкой на сервере',
      'Список приложений',
    ],
    keywords: [
      'сервер',
      'серверы',
      'список',
      'нагрузк',
      'метрик',
      'состоян',
      'приложен',
      'апп',
      'диск',
      'память',
      'процессор',
    ],
  },
  {
    intent: 'logs',
    label: 'Логи установки',
    description: 'Живой вывод того, что делает ИИ-агент на сервере',
    examples: [
      'Покажи логи установки',
      'Что происходит на сервере',
      'Как идёт деплой',
    ],
    keywords: [
      'лог',
      'журнал',
      'вывод',
      'что происход',
      'как идёт',
      'как идет',
      'прогресс',
      'ошибк',
      'сбой',
      'статус деплоя',
    ],
  },
]

/** Fast lookup by intent id. */
export const INTENT_BY_ID: Record<ServersIntent, IntentMeta | undefined> =
  Object.fromEntries(INTENT_CATALOGUE.map((m) => [m.intent, m])) as Record<
    ServersIntent,
    IntentMeta | undefined
  >

/**
 * Deterministic keyword classifier — the always-available fallback when the
 * gateway is unconfigured/down. Scores each intent by keyword hits (longer
 * keywords weigh more) and returns the best, or `help` when nothing matches.
 */
export function classifyByKeywords(text: string): {
  intent: ServersIntent
  confidence: number
} {
  const t = text.toLowerCase()
  if (!t.trim()) return { intent: 'help', confidence: 0 }

  let best: ServersIntent = 'help'
  let bestScore = 0
  for (const meta of INTENT_CATALOGUE) {
    let score = 0
    for (const kw of meta.keywords) {
      if (t.includes(kw)) score += Math.max(1, Math.round(kw.length / 3))
    }
    if (score > bestScore) {
      bestScore = score
      best = meta.intent
    }
  }
  if (bestScore === 0) return { intent: 'help', confidence: 0 }
  const confidence = Math.min(0.9, 0.4 + bestScore * 0.12)
  return { intent: best, confidence }
}
