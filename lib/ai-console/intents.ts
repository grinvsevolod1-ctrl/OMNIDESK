/**
 * Shared, dependency-free intent contract for the admin AI console.
 *
 * The console replaces the old fixed tab bar with a single natural-language
 * command box: the admin types what they want ("покажи логи", "хочу дожимать
 * жёстче", "добавь факт про доставку") and a router resolves it to one of these
 * intents, which the console then renders as an inline panel.
 *
 * This module is intentionally client-safe (no `server-only`, no DB, no AI SDK)
 * so BOTH the server router action and the client console import the exact same
 * catalogue — the single source of truth for labels, example prompts, and the
 * keyword fallback used when the LLM is unavailable.
 */

/** Every destination the console can open. `help` is the safe default. */
export type ConsoleIntent =
  | 'settings'
  | 'aggressiveness'
  | 'knowledge'
  | 'training'
  | 'corrections'
  | 'dialogs'
  | 'logs'
  | 'help'

/** Static description of one intent: how to show it, match it, and prompt it. */
export interface IntentMeta {
  intent: ConsoleIntent
  /** Short human label for the chip / panel header. */
  label: string
  /** One-line explanation shown under the label. */
  description: string
  /** Example prompts surfaced as quick chips and given to the LLM. */
  examples: string[]
  /**
   * Lowercase keyword stems for the deterministic fallback matcher. Matched as
   * substrings so stems ("логи" → "логах", "логов") catch inflected forms.
   */
  keywords: string[]
}

/**
 * The catalogue. Order matters: it drives chip order and, in the deterministic
 * fallback, earlier entries win ties. `help` is excluded from the chip list by
 * the console (it's the fallback, not a destination the admin picks).
 */
export const INTENT_CATALOGUE: IntentMeta[] = [
  {
    intent: 'settings',
    label: 'Настройки ИИ',
    description: 'Включение, тон, описание компании, модель и параметры',
    examples: [
      'Включи ИИ-ассистента',
      'Поменяй тон на дружелюбный',
      'Опиши, чем занимается компания',
      'Смени модель',
    ],
    keywords: [
      'настройк',
      'включ',
      'выключ',
      'тон',
      'персон',
      'о компан',
      'модел',
      'температур',
      'токен',
      'общает',
      'параметр',
    ],
  },
  {
    intent: 'aggressiveness',
    label: 'Агрессивность продаж',
    description: 'Насколько жёстко ИИ дожимает клиента до цели',
    examples: [
      'Хочу дожимать клиентов жёстче',
      'Сделай ИИ мягче',
      'Настрой агрессивность продаж',
      'Пусть меньше давит',
    ],
    keywords: [
      'агресс',
      'дожим',
      'дожа',
      'напор',
      'жёстк',
      'жестк',
      'мягч',
      'мягк',
      'дави',
      'давл',
      'настойчив',
      'продавл',
      'бог продаж',
    ],
  },
  {
    intent: 'knowledge',
    label: 'База знаний',
    description: 'Точные факты: цены, условия, ответы на частые вопросы',
    examples: [
      'Добавь факт про доставку',
      'Покажи базу знаний',
      'Занеси цену на услугу',
      'Что ИИ знает о компании',
    ],
    keywords: [
      'база знан',
      'знани',
      'факт',
      'цен',
      'услов',
      'прайс',
      'стоимост',
      'справочн',
      'faq',
      'частые вопрос',
    ],
  },
  {
    intent: 'training',
    label: 'Обучение',
    description: 'Уроки, тренировка на диалогах и проверка ответов ИИ',
    examples: [
      'Обучи ИИ на диалогах',
      'Проверь, как ИИ ответит',
      'Добавь урок',
      'Потренируй ассистента',
    ],
    keywords: [
      'обуч',
      'трениров',
      'урок',
      'научи',
      'проверь ответ',
      'как ответит',
      'черновик',
      'песочниц',
      'плейбук',
      'распознавани',
    ],
  },
  {
    intent: 'corrections',
    label: 'Правки',
    description: 'Жёсткие правила и исправления ошибок ИИ',
    examples: [
      'Добавь правку',
      'ИИ ошибается — исправь',
      'Покажи правки',
      'Запрети говорить про скидки',
    ],
    keywords: [
      'правк',
      'исправ',
      'ошиб',
      'коррек',
      'запрет',
      'нельзя говорить',
      'не говори',
      'правил',
    ],
  },
  {
    intent: 'dialogs',
    label: 'Диалоги',
    description: 'Подключение ИИ к диалогам и управление ведением',
    examples: [
      'Подключи ИИ к диалогу',
      'Покажи диалоги под ИИ',
      'Отключи ИИ от переписки',
      'Кого ведёт ассистент',
    ],
    keywords: [
      'диалог',
      'переписк',
      'подключ',
      'зачисл',
      'веди',
      'ведёт',
      'ведет',
      'отключ',
      'чат',
      'клиент',
      'enroll',
    ],
  },
  {
    intent: 'logs',
    label: 'Логи',
    description: 'Журнал работы ИИ, ошибки и диагностика',
    examples: [
      'Покажи логи',
      'Что с ошибками ИИ',
      'Диагностика ассистента',
      'Последние события ИИ',
    ],
    keywords: [
      'лог',
      'журнал',
      'диагност',
      'событ',
      'ошибк ии',
      'сбой',
      'не работает',
      'почему не отвеча',
      'статус',
    ],
  },
]

/** Fast lookup by intent id. */
export const INTENT_BY_ID: Record<ConsoleIntent, IntentMeta | undefined> =
  Object.fromEntries(INTENT_CATALOGUE.map((m) => [m.intent, m])) as Record<
    ConsoleIntent,
    IntentMeta | undefined
  >

/** Result contract returned by the router action and consumed by the console. */
export interface RouteResult {
  intent: ConsoleIntent
  /** Short, natural Russian acknowledgement shown above the opened panel. */
  reply: string
  /** 0..1 confidence; low confidence makes the console show a soft confirm. */
  confidence: number
  /** Which classifier produced this: the LLM or the offline keyword fallback. */
  source: 'ai' | 'fallback'
}

/**
 * Deterministic keyword classifier — the always-available fallback used when the
 * gateway is down/unconfigured, and as a prior the LLM path can defer to. Scores
 * every intent by counting keyword hits (longer keywords weigh more so a
 * specific match beats a generic one) and returns the best, or `help` when
 * nothing matches with enough signal.
 */
export function classifyByKeywords(text: string): {
  intent: ConsoleIntent
  confidence: number
} {
  const t = text.toLowerCase()
  if (!t.trim()) return { intent: 'help', confidence: 0 }

  let best: ConsoleIntent = 'help'
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
  // Map a raw hit-score to a rough 0.4..0.9 confidence band.
  const confidence = Math.min(0.9, 0.4 + bestScore * 0.12)
  return { intent: best, confidence }
}
