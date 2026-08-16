import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  analyzeDialogsForLessons,
  analyzeLossPatterns,
} from '@/lib/ai/manager-brain'
import { getDealHeat, listDealHeat } from '@/lib/ai/deal-heat'
import { countLessons, getAiModelStats } from '@/lib/data/ai-assist'
import {
  getAiPerformanceSummary,
  getAiPerformanceTrend,
  listLostDialogs,
  listUnderperformingDialogs,
} from '@/lib/data/ai-analytics'
import { getSystemHealth } from '@/lib/data/ai-health'
import { getFollowupSettings } from '@/lib/data/ai-followup'
import { countManualCorrections } from '@/lib/data/ai-assist-corrections'
import { countDirectives } from '@/lib/data/ai-directives'
import { listAiLogs } from '@/lib/data/ai-log'
import {
  getCuratorDiscipline,
  getCuratorDisciplineHistory,
  listAllTransferredLeads,
  type CuratorDisciplineHistory,
} from '@/lib/data/lead-cards'
import { LEAD_STATUS_LABELS, isLeadStatus } from '@/lib/lead-status'
import { mskDayKey } from '@/lib/time'
import type { AssistantReport } from './assistant'
import type { RunState } from './run-state'

/**
 * Observability tools: performance summaries and trends, deal temperature,
 * cost stats, system health, logs, briefings, loss analysis, weak-spot mining
 * and the downloadable report builder.
 */
export function analyticsTools(state: RunState) {
  return {
    getRecentLogs: tool({
      description:
        'Прочитать последние события из журнала ИИ-менеджера (ошибки, ответы, диагностика). Используй, когда админ спрашивает «почему ИИ молчит», «что с ошибками», «что происходит».',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(30).optional(),
      }),
      execute: async ({ limit }) => {
        const rows = await listAiLogs({ limit: limit ?? 12 })
        return {
          count: rows.length,
          logs: rows.slice(0, limit ?? 12).map((r) => ({
            level: r.level,
            event: r.event,
            message: r.message,
            at: r.createdAt,
          })),
        }
      },
    }),

    findWeakSpots: tool({
      description:
        'Разобрать реальные диалоги, где ИИ-продавец не дожал (передал человеку или клиент ушёл/не ликвид), и предложить конкретные уроки: на чём споткнулся и как правильно ответить в следующий раз. Вызывай, когда админ просит «разбери ошибки», «где мы проседаем», «чему тебя доучить», «учись на провалах». Уроки НЕ сохраняются автоматически — покажи их админу и, если он согласится, сохрани нужные через addLesson.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(25).optional(),
      }),
      execute: async ({ limit }) => {
        const dialogs = await listUnderperformingDialogs(limit ?? 8)
        if (dialogs.length === 0) {
          return { ok: true, dialogsAnalyzed: 0, lessons: [] }
        }
        const lessons = await analyzeDialogsForLessons(
          dialogs.map((d) => d.transcript),
        )
        return {
          ok: true,
          dialogsAnalyzed: dialogs.length,
          lessonCount: lessons.length,
          lessons,
        }
      },
    }),

    getPerformance: tool({
      description:
        'Свести реальные результаты работы ИИ-менеджера за период: сколько диалогов, сколько ликвидных лидов, сколько передано человеку, конверсия. Вызывай, когда админ спрашивает «как дела за неделю», «сколько дожали», «где теряем клиентов», «какая конверсия». Передай days (по умолчанию 7).',
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).optional(),
      }),
      execute: async ({ days }) => {
        const summary = await getAiPerformanceSummary(days ?? 7)
        return { ok: true, ...summary }
      },
    }),

    getCostStats: tool({
      description:
        'Показать расход на ИИ: по каждой модели — сколько запросов, доля успешных, средняя задержка и средний размер ответа в токенах. Вызывай, когда админ спрашивает «сколько тратим на ИИ», «расход токенов», «какая модель работает», «насколько быстро отвечает бот». Передай days (по умолчанию 7).',
      inputSchema: z.object({
        days: z.number().int().min(1).max(90).optional(),
      }),
      execute: async ({ days }) => {
        const stats = await getAiModelStats(days ?? 7)
        return { ok: true, models: stats }
      },
    }),

    exportReport: tool({
      description:
        'Собрать выгружаемый отчёт и дать админу файл для скачивания. Вызывай, когда админ просит «выгрузи отчёт», «сделай отчёт», «скачать статистику», «отчёт за месяц», «отчёт в файл/таблицу», «пришли сводку». scope=ai (по умолчанию) — отчёт о работе ИИ-менеджера; scope=curators — отчёт по менеджерам по кадрам и переданным лидам («выгрузи лиды менеджеров по кадрам», «отчёт по менеджерам по кадрам», «таблицу лидов в Excel»). Формат md — читаемый текстовый отчёт; csv — таблица для Excel (для scope=curators это полный список переданных лидов). Передай days (по умолчанию 7, для менеджеров по кадрам влияет только на текстовую сводку). После вызова коротко скажи, что отчёт готов к скачиванию по кнопке под сообщением, и назови 2–3 главные цифры.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).optional(),
        format: z.enum(['md', 'csv']).optional(),
        scope: z.enum(['ai', 'curators']).optional(),
      }),
      execute: async ({ days, format, scope }) => {
        const win = days ?? 7
        const fmt = format ?? 'md'

        if (scope === 'curators') {
          return exportCuratorReport(state, fmt)
        }
        const [perf, models, deals, followup, directives, lessons, corrections] =
          await Promise.all([
            getAiPerformanceSummary(win),
            getAiModelStats(win),
            listDealHeat(20),
            getFollowupSettings(),
            countDirectives(),
            countLessons(),
            countManualCorrections(),
          ])
        // MSK, not UTC: before 03:00 MSK the UTC date is still «yesterday».
        const today = mskDayKey(new Date())

        let report: AssistantReport
        if (fmt === 'csv') {
          const esc = (v: string | number | null) =>
            `"${String(v ?? '').replace(/"/g, '""')}"`
          const rows: (string | number | null)[][] = [
            ['Клиент', 'Канал', 'Статус', 'Балл', 'Категория', 'Часов молчания', 'Ждёт нас', 'Причины'],
            ...deals.map((d) => [
              d.contactName,
              d.channelType,
              d.status,
              d.score,
              d.band,
              d.hoursSinceLast ?? '',
              d.awaitingUs ? 'да' : 'нет',
              d.reasons.join('; '),
            ]),
          ]
          // Prepend BOM so Excel opens Cyrillic UTF-8 correctly; CRLF line ends.
          const content =
            '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
          report = {
            filename: `omnidesk-deals-${today}.csv`,
            mimeType: 'text/csv;charset=utf-8',
            content,
            label: `Горячие сделки (CSV, ${deals.length})`,
          }
        } else {
          const pct = (n: number) => `${n.toFixed(1)}%`
          const lines: string[] = [
            `# Отчёт по ИИ-менеджеру OMNIDESK`,
            ``,
            `Период: последние ${win} дн. · Сформирован: ${today}`,
            ``,
            `## Результаты`,
            `- Всего диалогов под ИИ: ${perf.totalDialogs}`,
            `- Ликвидных лидов: ${perf.liquid} (${pct(perf.liquidRatePct)})`,
            `- Неликвид: ${perf.notLiquid}`,
            `- Передано человеку: ${perf.handoffs} (${pct(perf.handoffRatePct)})`,
            `- Переведено дальше: ${perf.transferred}`,
            `- Ушли после одного сообщения: ${perf.unsubscribed}`,
            ``,
            `## Настройки и база`,
            `- Правил (директив): ${directives}`,
            `- Обучающих уроков: ${lessons}`,
            `- Ручных исправлений: ${corrections}`,
            `- Авто-дожим: ${followup.enabled ? 'включён' : 'выключен'} · задержка ${followup.delayHours} ч · до ${followup.maxTouches} касаний · тихие часы ${followup.quietStart}:00–${followup.quietEnd}:00 (${followup.quietTz})`,
            ``,
            `## Модели (расход и скорость)`,
            ...(models.length
              ? models.map(
                  (m) =>
                    `- ${m.model}: ${m.total} запросов · успешных ${pct(m.okRate * 100)} · ~${Math.round(m.avgLatencyMs)} мс · ~${Math.round(m.avgCompletionTokens)} токенов/ответ`,
                )
              : ['- Нет данных за период']),
            ``,
            `## Топ горячих сделок`,
            ...(deals.length
              ? deals
                  .slice(0, 15)
                  .map(
                    (d, i) =>
                      `${i + 1}. ${d.contactName ?? 'без имени'} (${d.channelType}) — ${d.score}/100, ${d.band}${d.awaitingUs ? ', ждёт нашего ответа' : ''}`,
                  )
              : ['- Нет активных сделок']),
            ``,
          ]
          report = {
            filename: `omnidesk-report-${today}.md`,
            mimeType: 'text/markdown;charset=utf-8',
            content: lines.join('\n'),
            label: `Отчёт за ${win} дн.`,
          }
        }

        state.report = report
        state.actions.push({
          kind: 'report',
          label: `Сформировал отчёт: ${report.label}`,
        })
        return {
          ok: true,
          format: fmt,
          windowDays: win,
          summary: {
            dialogs: perf.totalDialogs,
            liquid: perf.liquid,
            liquidRatePct: perf.liquidRatePct,
            handoffs: perf.handoffs,
            hotDeals: deals.filter((d) => d.band === 'hot').length,
          },
        }
      },
    }),

    dealTemperature: tool({
      description:
        'Оценить «температуру» сделок — насколько клиент горячий и готов к покупке. Вызывай, когда админ спрашивает «кого дожимать в первую очередь», «самые горячие клиенты», «кто готов купить», «насколько горячий этот диалог». Без conversationId вернёт топ самых горячих клиентов; с conversationId — оценку по конкретному диалогу. У каждой оценки есть балл 0–100, категория и понятные причины — проговори их админу.',
      inputSchema: z.object({
        conversationId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ conversationId, limit }) => {
        if (conversationId) {
          const heat = await getDealHeat(conversationId)
          if (!heat) return { ok: false, reason: 'not_found' }
          return { ok: true, deal: heat }
        }
        const deals = await listDealHeat(limit ?? 20)
        return { ok: true, count: deals.length, deals }
      },
    }),

    getSystemHealth: tool({
      description:
        'Проверить здоровье всей системы: статусы каналов (Telegram/WhatsApp/VK/MAX/лайв-чат), очередь задач и жив ли фоновый обработчик, ошибки ИИ за сутки, остаток средств на ИИ (баланс Gateway в долларах). Вызывай, когда админ говорит «ничего не работает», «бот молчит во всех каналах», «сколько осталось денег на ИИ», «всё ли в порядке», или в начале брифинга. Объясняй находки бытовым языком: «Telegram-канал отключён — поэтому бот там молчит».',
      inputSchema: z.object({}),
      execute: async () => {
        const h = await getSystemHealth()
        return { ok: true, ...h }
      },
    }),

    getTrend: tool({
      description:
        'Сравнить результаты ИИ-продавца за период с ПРЕДЫДУЩИМ таким же периодом: диалоги, ликвидные лиды, передачи человеку — с дельтами. Вызывай, когда админ спрашивает «стало лучше?», «помогли ли вчерашние правки», «сравни эту неделю с прошлой», «динамика». Передай days — длина окна (по умолчанию 7). Говори выводами: «конверсия выросла с X до Y — правки работают», а не голыми цифрами.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(180).optional(),
      }),
      execute: async ({ days }) => {
        const trend = await getAiPerformanceTrend(days ?? 7)
        return { ok: true, ...trend }
      },
    }),

    getBriefing: tool({
      description:
        'Собрать полный брифинг одним вызовом: динамика за сутки и неделю, самые горячие сделки, кто ждёт нашего ответа, здоровье каналов и очереди, ошибки, баланс на ИИ, статус авто-дожима. Вызывай ТОЛЬКО когда админ сам спрашивает в духе «как дела», «что нового», «в чём проблема, давай разберём», «проведи брифинг» — или когда ты предложил провести брифинг и админ согласился. Изложи как короткий устный доклад: 1) главное одним предложением, 2) что горит, 3) что просело, 4) что предлагаешь сделать. Никаких простыней.',
      inputSchema: z.object({}),
      execute: async () => {
        const [day, week, deals, health, followup] = await Promise.all([
          getAiPerformanceTrend(1),
          getAiPerformanceTrend(7),
          listDealHeat(10),
          getSystemHealth(),
          getFollowupSettings(),
        ])
        return {
          ok: true,
          today: day,
          week,
          hotDeals: deals.filter((d) => d.band === 'hot'),
          awaitingUs: deals.filter((d) => d.awaitingUs).length,
          health,
          followupEnabled: followup.enabled,
        }
      },
    }),

    analyzeLosses: tool({
      description:
        'Пакетный разбор ПРОИГРЫШЕЙ: прочитать слитые диалоги за период (клиент ушёл, не ликвид, передан человеку), сгруппировать причины по кластерам с долями («40% погибло на возражении по цене, 25% — долго не отвечали») и получить конкретное контр-предложение по каждому кластеру. Вызывай, когда админ спрашивает «где мы теряем клиентов», «почему сливаются», «разбери проигрыши за месяц». Это глубже findWeakSpots (тот даёт точечные уроки): здесь — карта утечек с приоритетами. Доложи кластеры от большего к меньшему и предложи закрыть самый крупный первым; правила/уроки сохраняй только с согласия админа (rememberDirective/addLesson).',
      inputSchema: z.object({
        days: z.number().int().min(1).max(180).optional(),
        limit: z.number().int().min(3).max(20).optional(),
      }),
      execute: async ({ days, limit }) => {
        const dialogs = await listLostDialogs(days ?? 30, limit ?? 15)
        if (dialogs.length === 0) {
          return { ok: true, dialogsAnalyzed: 0, patterns: [] }
        }
        const patterns = await analyzeLossPatterns(
          dialogs.map((d) => d.transcript),
        )
        return {
          ok: true,
          windowDays: days ?? 30,
          dialogsAnalyzed: dialogs.length,
          patterns,
        }
      },
    }),
  }
}

/**
 * Build the curators report (scope=curators of exportReport): md — discipline
 * summary with per-curator status breakdowns and orphaned-lead warnings;
 * csv — the full table of transferred leads for Excel.
 */
async function exportCuratorReport(state: RunState, fmt: 'md' | 'csv') {
  const [discipline, history, all, orphaned] = await Promise.all([
    getCuratorDiscipline(),
    getCuratorDisciplineHistory(30).catch(
      () => new Map<string, CuratorDisciplineHistory>(),
    ),
    listAllTransferredLeads({ limit: 1000 }),
    listAllTransferredLeads({ orphanedOnly: true, limit: 1 }),
  ])
  // MSK, not UTC: before 03:00 MSK the UTC date is still «yesterday».
  const today = mskDayKey(new Date())
  const statusLabel = (s: string | null) =>
    isLeadStatus(s) ? LEAD_STATUS_LABELS[s] : 'Не указан'

  let report: AssistantReport
  if (fmt === 'csv') {
    const esc = (v: string | number | null) =>
      `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows: (string | number | null)[][] = [
      ['ФИО', 'Телефон', 'Telegram', 'Город', 'Менеджер по кадрам', 'Статус', 'Статус подтверждён', 'Передан', 'Вакансия'],
      ...all.leads.map((l) => [
        l.fullName,
        l.phone,
        l.telegramUsername,
        l.city,
        l.curatorName ?? 'БЕЗ КУРАТОРА',
        statusLabel(l.status),
        l.statusConfirmedDate ?? '',
        l.transferredAt ? l.transferredAt.slice(0, 10) : '',
        l.vacancy,
      ]),
    ]
    // Prepend BOM so Excel opens Cyrillic UTF-8 correctly; CRLF line ends.
    const content =
      '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
    report = {
      filename: `omnidesk-curator-leads-${today}.csv`,
      mimeType: 'text/csv;charset=utf-8',
      content,
      label: `Лиды менеджеров по кадрам (CSV, ${all.leads.length})`,
    }
  } else {
    const lines: string[] = [
      `# Отчёт по менеджерам по кадрам OMNIDESK`,
      ``,
      `Сформирован: ${today} · Переданных лидов всего: ${all.total}${orphaned.total > 0 ? ` · БЕЗ КУРАТОРА: ${orphaned.total}` : ''}`,
      ``,
      ...(orphaned.total > 0
        ? [
            `> Внимание: ${orphaned.total} лид(ов) остались без менеджера по кадрам — переназначьте их на странице «Менеджеры по кадрам».`,
            ``,
          ]
        : []),
      `## Дисциплина по менеджерам по кадрам`,
      ...(discipline.length
        ? discipline.flatMap((d) => {
            const h = history.get(d.curatorId)
            const statuses = Object.entries(d.statusCounts)
              .map(([k, v]) => `${statusLabel(k)}: ${v}`)
              .join(' · ')
            return [
              `### ${d.curatorName}${d.city ? ` (${d.city})` : ''}`,
              `- Лидов: ${d.totalLeads} · сегодня подтверждено: ${d.confirmedToday} · осталось: ${d.pendingToday}`,
              ...(h && h.totalConfirms > 0
                ? [
                    `- За 30 дней: ${h.onTimeRatePct}% подтверждений вовремя (до 10:00 МСК) · всего ${h.totalConfirms} · активных дней ${h.activeDays}`,
                  ]
                : []),
              ...(statuses ? [`- Статусы: ${statuses}`] : []),
              ``,
            ]
          })
        : ['- Активных менеджеров по кадрам нет', '']),
    ]
    report = {
      filename: `omnidesk-curators-${today}.md`,
      mimeType: 'text/markdown;charset=utf-8',
      content: lines.join('\n'),
      label: `Отчёт по менеджерам по кадрам`,
    }
  }

  state.report = report
  state.actions.push({
    kind: 'report',
    label: `Сформировал отчёт: ${report.label}`,
  })
  return {
    ok: true,
    scope: 'curators',
    format: fmt,
    summary: {
      totalLeads: all.total,
      orphanedLeads: orphaned.total,
      curators: discipline.length,
      pendingToday: discipline.reduce((s, d) => s + d.pendingToday, 0),
    },
  }
}
