import 'server-only'

import {
  GATEWAY_URL,
  gatewayStatusHint,
  resolveModel,
  type GatewayResponse,
} from './ai/brain/core'
import {
  listSites,
  liveBalance,
  stateForPeriod,
  type GodSite,
  type SitePeriod,
} from './god-sites'

/**
 * AI report generator for the god-panel "Сайты" tab: turns the FULL current
 * state of every managed site into a free-form analytical report via the AI
 * Gateway. The operator types any request («отчёт за день», «за 3 часа»,
 * «сравни кабинеты за неделю») — the model gets complete context and answers.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only. This module imports the
 * SHARED gateway plumbing from lib/ai/brain/core (allowed direction); nothing
 * under lib/ai-console/ may ever import THIS file.
 *
 * Context strategy — «чтобы у него было полное представление»: the raw site
 * state is serialized VERBATIM (JSON.stringify of the whole state object),
 * so any field added to SiteState in the future automatically reaches the
 * model without touching this file. Period aggregates are layered on top as
 * pre-computed views so the model doesn't have to re-derive the simulation.
 */

const REPORT_PERIODS: SitePeriod[] = ['today', 'yesterday', 'week', 'month']

const PERIOD_LABELS: Record<SitePeriod, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  week: 'Неделя',
  month: 'Месяц',
  all: 'Всё время',
}

/** Compact per-period aggregate rows the model can quote without math. */
function periodSummary(site: GodSite, now: Date): string {
  const lines: string[] = []
  for (const p of REPORT_PERIODS) {
    const s = stateForPeriod(site.state, p, now)
    const running = s.campaigns.filter((c) => c.status === 'running')
    const cost = running.reduce((a, c) => a + c.cost, 0)
    const shows = running.reduce((a, c) => a + c.shows, 0)
    const clicks = running.reduce((a, c) => a + c.clicks, 0)
    const goals = running.reduce((a, c) => a + c.goals, 0)
    const revenue = running.reduce((a, c) => a + c.revenue, 0)
    lines.push(
      `  ${PERIOD_LABELS[p]}: расход=${cost.toFixed(2)} показы=${Math.round(shows)} ` +
        `клики=${Math.round(clicks)} конверсии=${goals.toFixed(1)} доход=${revenue.toFixed(2)}`,
    )
  }
  return lines.join('\n')
}

/** Build the full model context for one site. */
function siteContext(site: GodSite, now: Date): string {
  const auto = site.state.autoSpend
  const header = [
    `САЙТ «${site.title}» (slug: ${site.slug})`,
    `Баланс сейчас (живой): ${liveBalance(site.state, now).toFixed(2)} ${site.state.currency}`,
    auto?.enabled
      ? `Авто-скрутка: ВКЛ, бюджет/день=${auto.dailyBudget}, работает с ${auto.startDay ?? '—'}, ` +
        `профиль=${auto.profile ?? 'исторический'}, списано всего=${auto.spentToDate ?? '—'}`
      : 'Авто-скрутка: выключена',
    `Агрегаты по периодам (только активные кампании):`,
    periodSummary(site, now),
    // Raw state VERBATIM — future fields flow through automatically.
    `Полное состояние (JSON): ${JSON.stringify(site.state)}`,
  ]
  return header.join('\n')
}

const SYSTEM_PROMPT = `Ты аналитик рекламных кабинетов Яндекс Директ. Тебе дают полное текущее состояние
нескольких управляемых кабинетов (баланс, кампании со всеми метриками, настройки
авто-скрутки, агрегаты по периодам) и свободный запрос руководителя.

Правила:
- Отвечай на русском, структурированно, по делу. Заголовки и списки уместны.
- Все числа бери ТОЛЬКО из переданных данных, ничего не выдумывай. Если для
  запрошенного периода данных нет (например «за 3 часа» — есть только агрегаты
  по дням), честно скажи это и дай ближайшую оценку из имеющегося (например,
  долю дневного расхода) с пометкой, что это оценка.
- Считай производные метрики сам: CTR=клики/показы, CPC=расход/клики,
  CPA=расход/конверсии, CR=конверсии/клики, ДРР=расход/доход, ROI=(доход−расход)/расход.
- Сравнивай кабинеты между собой, отмечай аномалии (низкий баланс, дорогой CPA,
  остановленные кампании, исчерпание бюджета).
- Заверши отчёт короткими практическими рекомендациями.`

export type GodReportResult =
  | { ok: true; report: string; model: string }
  | { ok: false; message: string }

/**
 * Generate a free-form report over ALL managed sites (or a subset by id).
 * `request` is the operator's free text — period, focus, format, anything.
 */
export async function generateGodReport(
  request: string,
  siteIds?: string[],
): Promise<GodReportResult> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) {
    return {
      ok: false,
      message: 'Нет ключа AI_GATEWAY_API_KEY — отчёт не сгенерирован.',
    }
  }

  const all = await listSites()
  const sites =
    siteIds && siteIds.length > 0
      ? all.filter((s) => siteIds.includes(s.id))
      : all
  if (sites.length === 0) {
    return { ok: false, message: 'Нет сайтов для отчёта.' }
  }

  const now = new Date()
  const context = sites.map((s) => siteContext(s, now)).join('\n\n---\n\n')
  const model = resolveModel()

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `ДАННЫЕ КАБИНЕТОВ (снимок на ${now.toISOString()}):\n\n${context}\n\n` +
              `ЗАПРОС РУКОВОДИТЕЛЯ:\n${request.trim() || 'Дневной отчёт по всем запущенным кабинетам.'}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    })
    if (!res.ok) {
      return {
        ok: false,
        message: `AI Gateway вернул HTTP ${res.status}${gatewayStatusHint(res.status)}`,
      }
    }
    const data = (await res.json()) as GatewayResponse
    const report = (data.choices?.[0]?.message?.content ?? '').trim()
    if (!report) {
      return { ok: false, message: 'Модель вернула пустой отчёт.' }
    }
    return { ok: true, report, model }
  } catch {
    return { ok: false, message: 'Не удалось связаться с AI Gateway.' }
  }
}
