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
import {
  DEFAULT_DAY_JITTER,
  DEFAULT_WEEKEND_DIP,
  jitter,
  round2,
  weekdayFactor,
} from './god-sites-sim'

/**
 * AI report generator for the god-panel "Сайты" tab.
 *
 * SACRED INVARIANT (AGENTS.md §4): god-panel only. Imports the SHARED gateway
 * plumbing from lib/ai/brain/core (allowed direction); nothing under
 * lib/ai-console/ may ever import THIS file.
 *
 * PRESENTATION INVARIANT: the model must believe (and write) that the data
 * came from the Yandex Direct API. NOTHING here may leak internal mechanics —
 * no autoSpend, no profiles/curves, no "панель", no raw internal JSON. The
 * context is rebuilt as a Direct-style export: cabinet header, money
 * movement with dates, per-day spend statistics, per-campaign metrics by
 * period. The daily series uses the exact same per-day math the balance
 * engine commits with, so the report always agrees with the vitrine.
 */

const REPORT_PERIODS: SitePeriod[] = ['today', 'yesterday', 'week', 'month']

const PERIOD_LABELS: Record<SitePeriod, string> = {
  today: 'Сегодня',
  yesterday: 'Вчера',
  week: 'Последние 7 дней',
  month: 'Последние 30 дней',
  all: 'Всё время',
}

/* --------------------------- Direct-style context ------------------------ */

function dayKeyAt(now: Date, tz: number, minusDays: number): string {
  const shifted = new Date(now.getTime() + tz * 3_600_000 - minusDays * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

function fmtMoney(n: number, currency: string): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)} ${currency}`
}

/**
 * Per-day spend history (completed days only), reconstructed with the SAME
 * per-day formula the balance engine commits with — budget × weekday factor ×
 * deterministic day jitter. Presented as plain Direct statistics.
 */
function dailySpendRows(site: GodSite, now: Date): string[] {
  const auto = site.state.autoSpend
  if (!auto?.enabled || !auto.startDay) return []
  const tz = auto.tzOffsetHours ?? 3
  const dip = auto.weekendDip ?? DEFAULT_WEEKEND_DIP
  const spread = auto.dayJitter ?? DEFAULT_DAY_JITTER
  const today = dayKeyAt(now, tz, 0)

  const rows: string[] = []
  // Walk back up to 14 completed days, never earlier than the campaign start.
  for (let back = 14; back >= 1; back--) {
    const day = dayKeyAt(now, tz, back)
    if (day < auto.startDay || day >= today) continue
    const spend = round2(
      auto.dailyBudget * weekdayFactor(day, dip) * jitter(`${day}:day`, spread),
    )
    rows.push(`  ${day}: расход ${fmtMoney(spend, site.state.currency)}`)
  }
  return rows
}

/** Money movement block: deposit date/amount, total spent, current balance. */
function moneyMovement(site: GodSite, now: Date): string[] {
  const auto = site.state.autoSpend
  const live = liveBalance(site.state, now)
  const cur = site.state.currency
  const lines = [`Текущий остаток на счёте: ${fmtMoney(live, cur)}`]
  if (auto?.enabled && auto.startDay) {
    const spent = Math.max(0, (auto.spentToDate ?? 0) + (site.state.balance - live))
    lines.push(
      `Зачисление средств: ${auto.startDay} — ${fmtMoney(round2(live + spent), cur)}`,
      `Израсходовано с ${auto.startDay}: ${fmtMoney(round2(spent), cur)}`,
      `Средний дневной расход (план): ${fmtMoney(auto.dailyBudget, cur)}`,
    )
  }
  return lines
}

/** Per-campaign metric rows for one period. */
function campaignRows(site: GodSite, period: SitePeriod, now: Date): string[] {
  const s = stateForPeriod(site.state, period, now)
  return s.campaigns.map((c) => {
    const ctr = c.shows > 0 ? ((c.clicks / c.shows) * 100).toFixed(2) : '0'
    const cpc = c.clicks > 0 ? (c.cost / c.clicks).toFixed(2) : '—'
    const cpa = c.goals > 0 ? (c.cost / c.goals).toFixed(2) : '—'
    return (
      `  «${c.name}» [${c.status === 'running' ? 'идут показы' : 'остановлена'}] ` +
      `(${c.type}; ${c.strategy}; ${c.platform}; регионы: ${c.regions}; ` +
      `период размещения ${c.startDate} — ${c.endDate || 'не ограничен'}): ` +
      `расход=${c.cost.toFixed(2)} показы=${Math.round(c.shows)} клики=${Math.round(c.clicks)} ` +
      `CTR=${ctr}% CPC=${cpc} конверсии=${c.goals.toFixed(1)} CPA=${cpa} ` +
      `доход=${c.revenue.toFixed(2)} отказы=${c.bounce.toFixed(1)}% ` +
      `недельный бюджет=${c.weeklyBudget}`
    )
  })
}

/** Full Direct-style context for one cabinet. NO internal fields leak here. */
function siteContext(site: GodSite, now: Date): string {
  const blocks: string[] = [
    `=== КАБИНЕТ «${site.title}» ===`,
    `Логин: ${site.state.login}`,
    `Организация: ${site.state.organization} (ID ${site.state.orgId})`,
    '',
    'ДВИЖЕНИЕ СРЕДСТВ:',
    ...moneyMovement(site, now).map((l) => `  ${l}`),
  ]

  const daily = dailySpendRows(site, now)
  if (daily.length > 0) {
    blocks.push('', 'РАСХОД ПО ДНЯМ (завершённые дни):', ...daily)
  }

  for (const p of REPORT_PERIODS) {
    blocks.push('', `СТАТИСТИКА — ${PERIOD_LABELS[p].toUpperCase()}:`)
    blocks.push(...campaignRows(site, p, now))
  }
  return blocks.join('\n')
}

/* ------------------------------ Gateway call ----------------------------- */

const SYSTEM_PROMPT = `Ты — ведущий специалист по контекстной рекламе. Ты готовишь профессиональные
отчёты по рекламным кабинетам Яндекс Директ для руководителя. Данные тебе
выгружены из API Яндекс Директа: движение средств по счёту с датами, расход по
дням, статистика кампаний по периодам.

ФОРМАТ ОТЧЁТА (markdown):
- Заголовок с названием кабинета/кабинетов и отчётным периодом (с датами).
- «Финансы»: остаток на счёте, дата и сумма зачисления, израсходовано за
  период, на сколько дней хватит остатка при текущем темпе.
- «Динамика по дням»: таблица дата → расход, отметь провалы/пики и выходные.
- «Кампании»: таблица по кампаниям с расходом, показами, кликами, CTR, CPC,
  конверсиями, CPA, доходом; выдели лучшую и худшую.
- «Выводы»: 3-5 содержательных мыслей — что происходит и почему, какие
  тренды, где деньги работают, а где сгорают.
- «Рекомендации»: конкретные действия с ожидаемым эффектом.

ЖЕЛЕЗНЫЕ ПРАВИЛА:
- Все числа — ТОЛЬКО из выгрузки. Ничего не выдумывай. Производные метрики
  (CTR, CPC, CPA, CR, ДРР, ROI) считай сам и показывай расчёт при спорных.
- Если запрошенный период мельче доступной детализации (например «за 3 часа»,
  а есть данные по дням) — скажи об этом прямо и дай оценку из дневных данных
  с пометкой «оценка».
- Пиши как живой специалист: с датами, деньгами и мыслями, без воды.
- НИКОГДА не упоминай, что данные пришли текстом/JSON, не рассуждай об их
  происхождении. Это выгрузка из Директа — точка.
- Если запрос руководителя неоднозначен (непонятен период, кабинет, фокус или
  формат) — НЕ пиши отчёт наугад. Задай 1-3 коротких уточняющих вопроса
  списком и жди ответа.
- Отвечай на русском.`

export type ReportChatMessage = { role: 'user' | 'assistant'; content: string }

export type GodReportResult =
  | { ok: true; report: string; model: string }
  | { ok: false; message: string }

/**
 * Generate a report (or a clarifying question) over managed sites. `messages`
 * is the running conversation — the operator can answer clarifying questions
 * and the model keeps full context of both the data and the dialog.
 */
export async function generateGodReport(
  messages: ReportChatMessage[],
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
    return { ok: false, message: 'Нет кабинетов для отчёта.' }
  }

  const now = new Date()
  const context = sites.map((s) => siteContext(s, now)).join('\n\n')
  const model = resolveModel()

  const first = messages[0]
  const rest = messages.slice(1)
  const stamp = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(now)

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
              `ВЫГРУЗКА ИЗ ЯНДЕКС ДИРЕКТА (актуальна на ${stamp} МСК):\n\n${context}\n\n` +
              `ЗАПРОС РУКОВОДИТЕЛЯ:\n${(first?.content ?? '').trim() || 'Полный отчёт по всем кабинетам за последние 7 дней.'}`,
          },
          ...rest.map((m) => ({ role: m.role, content: m.content })),
        ],
        temperature: 0.4,
        max_tokens: 3000,
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
