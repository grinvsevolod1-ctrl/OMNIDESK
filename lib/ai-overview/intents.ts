/**
 * Уровень 1 ИИ-каскада Обзора: детерминированный разбор запроса БЕЗ модели
 * (0 токенов). Каталог интентов + парсер периода + fuzzy-матч имени источника.
 *
 * Client-safe: без server-only, БД и SDK — клиент использует тот же парсер для
 * уровня 0 (мгновенное открытие карточки по имени, без запроса на сервер).
 */

export type OverviewIntent =
  | 'summary' /* «как дела», сводка по всем источникам */
  | 'top_sources' /* «топ источников», «какой источник лучший» */
  | 'source_stats' /* цифры по конкретному источнику */
  | 'money' /* расходы/пополнения/баланс */
  | 'leads' /* лиды/воронка/передано */
  | 'help' /* что ты умеешь */
  | 'unknown'

export interface ParsedPeriod {
  fromISO: string
  toISO: string
  label: string
}

/** Нормализация: нижний регистр, ё→е, пунктуация → пробелы. */
export function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Границы слова для кириллицы: JS-`\b` опирается на `\w` (только латиница),
 * поэтому `/\bсегодня\b/` НИКОГДА не совпадает. Используем lookaround
 * по кириллическим буквам.
 */
function cyrWord(pattern: string): RegExp {
  return new RegExp(`(?<![а-яё])(?:${pattern})(?![а-яё])`)
}

function dayStart(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function makePeriod(daysBack: number, label: string, now: Date): ParsedPeriod {
  const todayStart = dayStart(now)
  const to = new Date(todayStart)
  to.setDate(to.getDate() + 1)
  const from = new Date(todayStart)
  from.setDate(from.getDate() - daysBack)
  return { fromISO: from.toISOString(), toISO: to.toISOString(), label }
}

/**
 * Период из свободного текста регэкспами: «сегодня», «вчера», «за неделю»,
 * «за месяц», «за N дней», «за 90 дней». Null — период не упомянут
 * (вызывающий подставит период, выбранный на вкладке).
 */
export function parsePeriod(text: string, now = new Date()): ParsedPeriod | null {
  const q = normalizeQuery(text)

  if (cyrWord('сегодня').test(q)) return makePeriod(0, 'сегодня', now)

  if (cyrWord('вчера').test(q)) {
    const todayStart = dayStart(now)
    const from = new Date(todayStart)
    from.setDate(from.getDate() - 1)
    return {
      fromISO: from.toISOString(),
      toISO: todayStart.toISOString(),
      label: 'вчера',
    }
  }

  const nDays = q.match(
    /(?<![а-яё])(?:за|последние)\s+(\d{1,3})\s*(?:дней|дня|день|д)(?![а-яё])/,
  )
  if (nDays) {
    const n = Math.min(365, Math.max(1, Number(nDays[1])))
    return makePeriod(n - 1, `за ${n} дн.`, now)
  }

  if (/(?<![а-яё])недел/.test(q)) return makePeriod(6, 'за неделю', now)
  if (/(?<![а-яё])месяц/.test(q)) return makePeriod(29, 'за месяц', now)
  if (/(?<![а-яё])квартал|90 дней/.test(q)) return makePeriod(89, 'за 90 дней', now)

  return null
}

/**
 * Fuzzy-поиск источника по имени в свободном тексте. Возвращает id лучшего
 * совпадения или null. Правила (по убыванию силы): точное имя → имя целиком
 * содержится в запросе → запрос содержится в имени (для коротких запросов).
 */
export function matchSourceName(
  text: string,
  sources: { id: string; name: string }[],
): { id: string; name: string } | null {
  const q = normalizeQuery(text)
  if (!q) return null

  let best: { id: string; name: string } | null = null
  let bestScore = 0
  for (const s of sources) {
    const n = normalizeQuery(s.name)
    if (!n) continue
    let score = 0
    if (n === q) score = 3
    else if (q.includes(n)) score = 2
    else if (n.includes(q) && q.length >= 3) score = 1
    if (score > bestScore) {
      bestScore = score
      best = { id: s.id, name: s.name }
    }
  }
  return best
}

/** Стемы ключевых слов интентов (нормализованный текст). */
const INTENT_STEMS: Record<Exclude<OverviewIntent, 'unknown'>, string[]> = {
  summary: [
    'как дела',
    'что происходит',
    'сводка',
    'обзор',
    'общая картина',
    'итог',
    'статистика',
  ],
  top_sources: [
    'топ',
    'лучш',
    'худш',
    'сравн',
    'какой источник',
    'рейтинг',
    'эффективн',
  ],
  source_stats: ['покажи', 'цифры', 'детал', 'подробн'],
  money: [
    'расход',
    'потрат',
    'пополн',
    'баланс',
    'деньг',
    'бюджет',
    'стоимост',
    'цена лида',
  ],
  leads: ['лид', 'воронк', 'передан', 'ликвид', 'конверси'],
  help: ['что ты умеешь', 'помощь', 'как пользоваться', 'справка'],
}

export interface OverviewClassification {
  intent: OverviewIntent
  /** true — совпадение уверенное, можно отвечать без модели. */
  confident: boolean
}

/**
 * Детерминированная классификация запроса по ключевым стемам. Уверенный матч
 * закрывает запрос на уровне 1 (0 токенов); неуверенный уходит выше по каскаду.
 */
export function classifyOverviewQuery(text: string): OverviewClassification {
  const q = normalizeQuery(text)
  if (!q) return { intent: 'unknown', confident: false }

  let bestIntent: OverviewIntent = 'unknown'
  let bestHits = 0
  for (const [intent, stems] of Object.entries(INTENT_STEMS) as [
    Exclude<OverviewIntent, 'unknown'>,
    string[],
  ][]) {
    let hits = 0
    for (const stem of stems) if (q.includes(stem)) hits++
    if (hits > bestHits) {
      bestHits = hits
      bestIntent = intent
    }
  }

  if (bestHits === 0) return { intent: 'unknown', confident: false }

  // Мутационные глаголы всегда требуют модели (подтверждаемые действия):
  // детерминированный уровень отвечает только на чтение.
  if (/(?<![а-яё])(?:переимен|удали|создай|добавь|перенеси|отвяжи|привяжи|измени)/.test(q)) {
    return { intent: bestIntent, confident: false }
  }

  return { intent: bestIntent, confident: true }
}
