import 'server-only'

/**
 * SQL-хендлеры интентов Обзора: превращают распознанный интент в структурный
 * OverviewAnswer. Одни и те же хендлеры исполняют ответы уровня 1
 * (детерминированный разбор) и уровня 2 (LLM-роутер) — модель никогда не
 * пишет сам ответ, только выбирает интент.
 *
 * Все чтения идут через кэшированные роллапы lib/data/sources (60с), поэтому
 * повторные вопросы не бьют по базе.
 */
import { getSourceDetail, getSourcesOverview } from '@/lib/data/sources'
import type { AnswerMetric, OverviewAnswer } from './types'
import type { OverviewIntent, ParsedPeriod } from './intents'

export interface HandlerContext {
  period: ParsedPeriod
  /** Смещение таймзоны админа (JS getTimezoneOffset, минуты). */
  tzOffsetMinutes: number
  /** Источник, найденный в тексте запроса (если найден). */
  sourceId?: string | null
  /** ВСЕ источники, упомянутые в тексте (для «сравни X и Y»). */
  sourceIds?: string[]
}

function money(v: number): string {
  return v % 1 === 0 ? v.toLocaleString('ru-RU') : v.toFixed(2)
}

async function summaryAnswer(ctx: HandlerContext): Promise<OverviewAnswer> {
  const o = await getSourcesOverview(
    ctx.period.fromISO,
    ctx.period.toISO,
    ctx.tzOffsetMinutes,
  )
  let people = 0
  let transferred = 0
  let expense = 0
  let income = 0
  for (const s of o.items) {
    people += s.stats.people
    transferred += s.stats.transferred
    expense += s.stats.expense
    income += s.stats.income
  }
  if (o.unassigned) {
    people += o.unassigned.stats.people
    transferred += o.unassigned.stats.transferred
  }
  const top = [...o.items].sort((a, b) => b.stats.people - a.stats.people)[0]
  const metrics: AnswerMetric[] = [
    { label: 'Написали людей', value: String(people) },
    {
      label: 'Передано лидов',
      value: String(transferred),
      sub: people > 0 ? `${Math.round((transferred / people) * 100)}% от написавших` : undefined,
    },
    { label: 'Потрачено', value: money(expense) },
    { label: 'Пополнено', value: money(income) },
  ]
  if (top && top.stats.people > 0) {
    metrics.push({
      label: 'Самый активный источник',
      value: top.name,
      sub: `${top.stats.people} людей`,
    })
  }
  return {
    kind: 'summary',
    title: 'Сводка по всем источникам',
    periodLabel: ctx.period.label,
    metrics,
  }
}

async function topSourcesAnswer(ctx: HandlerContext): Promise<OverviewAnswer> {
  const o = await getSourcesOverview(
    ctx.period.fromISO,
    ctx.period.toISO,
    ctx.tzOffsetMinutes,
  )
  const rows = [...o.items]
    .sort((a, b) => b.stats.people - a.stats.people)
    .slice(0, 10)
    .map((s) => [
      s.name,
      s.stats.people,
      s.stats.transferred,
      s.stats.expense > 0 ? money(s.stats.expense) : '—',
      s.stats.transferred > 0 && s.stats.expense > 0
        ? money(Math.round((s.stats.expense / s.stats.transferred) * 100) / 100)
        : '—',
    ])
  return {
    kind: 'table',
    title: 'Источники по активности',
    periodLabel: ctx.period.label,
    table: {
      columns: ['Источник', 'Людей', 'Передано', 'Расход', 'Цена лида'],
      rows,
    },
  }
}

/** Антирейтинг: слабейшие источники по людям (с ненулевой активностью — вниз). */
async function worstSourcesAnswer(ctx: HandlerContext): Promise<OverviewAnswer> {
  const o = await getSourcesOverview(
    ctx.period.fromISO,
    ctx.period.toISO,
    ctx.tzOffsetMinutes,
  )
  const rows = [...o.items]
    .sort((a, b) => a.stats.people - b.stats.people)
    .slice(0, 10)
    .map((s) => [
      s.name,
      s.stats.people,
      s.stats.transferred,
      s.stats.expense > 0 ? money(s.stats.expense) : '—',
    ])
  return {
    kind: 'table',
    title: 'Слабейшие источники (по людям)',
    periodLabel: ctx.period.label,
    table: { columns: ['Источник', 'Людей', 'Передано', 'Расход'], rows },
  }
}

/**
 * Сравнение конкретных источников бок о бок. Null — в тексте упомянуто
 * меньше двух источников, каскад поднимется выше (модель уточнит).
 */
async function compareSourcesAnswer(
  ctx: HandlerContext,
): Promise<OverviewAnswer | null> {
  const ids = ctx.sourceIds ?? []
  if (ids.length < 2) return null
  const o = await getSourcesOverview(
    ctx.period.fromISO,
    ctx.period.toISO,
    ctx.tzOffsetMinutes,
  )
  const picked = o.items.filter((s) => ids.includes(s.id))
  if (picked.length < 2) return null
  const rows = picked.map((s) => [
    s.name,
    s.stats.people,
    s.stats.transferred,
    s.stats.expense > 0 ? money(s.stats.expense) : '—',
    s.stats.transferred > 0 && s.stats.expense > 0
      ? money(Math.round((s.stats.expense / s.stats.transferred) * 100) / 100)
      : '—',
  ])
  return {
    kind: 'table',
    title: `Сравнение: ${picked.map((s) => s.name).join(' и ')}`,
    periodLabel: ctx.period.label,
    table: {
      columns: ['Источник', 'Людей', 'Передано', 'Расход', 'Цена лида'],
      rows,
    },
  }
}

async function sourceStatsAnswer(
  ctx: HandlerContext,
): Promise<OverviewAnswer | null> {
  if (!ctx.sourceId) return null
  const d = await getSourceDetail(
    ctx.sourceId,
    ctx.period.fromISO,
    ctx.period.toISO,
    ctx.tzOffsetMinutes,
  )
  if (!d) return null
  return {
    kind: 'summary',
    title: d.name,
    periodLabel: ctx.period.label,
    metrics: [
      { label: 'Написали', value: String(d.funnel.people) },
      {
        label: 'Передан человеку',
        value: String(d.funnel.handoff),
        sub:
          d.funnel.people > 0
            ? `${Math.round((d.funnel.handoff / d.funnel.people) * 100)}%`
            : undefined,
      },
      { label: 'Ликвид', value: String(d.funnel.liquid) },
      { label: 'Передано', value: String(d.funnel.transferred) },
      {
        label: 'Потрачено',
        value: `${money(d.finance.expense)} ${d.finance.currency}`,
      },
      {
        label: 'Баланс за всё время',
        value: `${money(d.finance.balanceAllTime)} ${d.finance.currency}`,
      },
    ],
  }
}

async function moneyAnswer(ctx: HandlerContext): Promise<OverviewAnswer> {
  // «Сколько потратили на X» — если в вопросе назван источник, отвечаем
  // сводкой именно по нему, а не общей таблицей.
  if (ctx.sourceId) {
    const d = await getSourceDetail(
      ctx.sourceId,
      ctx.period.fromISO,
      ctx.period.toISO,
      ctx.tzOffsetMinutes,
    )
    if (d) {
      return {
        kind: 'summary',
        title: `Деньги: ${d.name}`,
        periodLabel: ctx.period.label,
        metrics: [
          {
            label: 'Потрачено',
            value: `${money(d.finance.expense)} ${d.finance.currency}`,
          },
          {
            label: 'Пополнено',
            value: `${money(d.finance.income)} ${d.finance.currency}`,
          },
          {
            label: 'Баланс за всё время',
            value: `${money(d.finance.balanceAllTime)} ${d.finance.currency}`,
          },
          ...(d.funnel.transferred > 0 && d.finance.expense > 0
            ? [
                {
                  label: 'Цена переданного лида',
                  value: `${money(
                    Math.round(
                      (d.finance.expense / d.funnel.transferred) * 100,
                    ) / 100,
                  )} ${d.finance.currency}`,
                },
              ]
            : []),
        ],
      }
    }
  }
  const o = await getSourcesOverview(
    ctx.period.fromISO,
    ctx.period.toISO,
    ctx.tzOffsetMinutes,
  )
  const rows = [...o.items]
    .filter((s) => s.stats.expense > 0 || s.stats.income > 0)
    .sort((a, b) => b.stats.expense - a.stats.expense)
    .map((s) => [
      s.name,
      s.stats.income > 0 ? `+${money(s.stats.income)}` : '—',
      s.stats.expense > 0 ? `−${money(s.stats.expense)}` : '—',
      s.currency,
    ])
  if (rows.length === 0) {
    return {
      kind: 'text',
      title: 'Деньги',
      text: `За выбранный период (${ctx.period.label}) движений по источникам не было.`,
    }
  }
  return {
    kind: 'table',
    title: 'Деньги по источникам',
    periodLabel: ctx.period.label,
    table: { columns: ['Источник', 'Пополнено', 'Потрачено', 'Валюта'], rows },
  }
}

async function leadsAnswer(ctx: HandlerContext): Promise<OverviewAnswer> {
  const o = await getSourcesOverview(
    ctx.period.fromISO,
    ctx.period.toISO,
    ctx.tzOffsetMinutes,
  )
  const rows = [...o.items]
    .sort((a, b) => b.stats.transferred - a.stats.transferred)
    .map((s) => [
      s.name,
      s.stats.people,
      s.stats.handoff,
      s.stats.liquid,
      s.stats.transferred,
    ])
  return {
    kind: 'table',
    title: 'Воронка лидов по источникам',
    periodLabel: ctx.period.label,
    table: {
      columns: ['Источник', 'Написали', 'Передан человеку', 'Ликвид', 'Передано'],
      rows,
    },
  }
}

function helpAnswer(): OverviewAnswer {
  return {
    kind: 'text',
    title: 'Что умеет строка',
    text: [
      'Спросите про источники своими словами, например:',
      '• «как дела за неделю» — общая сводка;',
      '• «топ источников за месяц» — сравнение по активности;',
      '• «лиды по авито за 30 дней» — воронка конкретного источника;',
      '• «сколько потратили вчера» — деньги;',
      '• «переименуй Авито в Авито Москва» — изменения (с подтверждением).',
    ].join('\n'),
  }
}

/**
 * Исполнить интент чтения. Null — хендлер не смог ответить (например,
 * source_stats без найденного источника) и каскад должен подняться выше.
 */
export async function executeIntent(
  intent: OverviewIntent,
  ctx: HandlerContext,
): Promise<OverviewAnswer | null> {
  switch (intent) {
    case 'summary':
      return summaryAnswer(ctx)
    case 'top_sources':
      return topSourcesAnswer(ctx)
    case 'worst_sources':
      return worstSourcesAnswer(ctx)
    case 'compare_sources':
      return compareSourcesAnswer(ctx)
    case 'source_stats': {
      const bySource = await sourceStatsAnswer(ctx)
      // «покажи цифры» без имени источника — отвечаем общей сводкой.
      return bySource ?? summaryAnswer(ctx)
    }
    case 'money':
      return moneyAnswer(ctx)
    case 'leads':
      return leadsAnswer(ctx)
    case 'help':
      return helpAnswer()
    default:
      return null
  }
}
