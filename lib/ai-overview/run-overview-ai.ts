import 'server-only'

/**
 * ИИ-каскад строки Обзора: уровни 1 → 2 → 3 с максимальной экономией токенов.
 *
 *   Уровень 1 (0 токенов): детерминированная классификация (intents.ts) +
 *     SQL-хендлеры (handlers.ts). Закрывает типовые вопросы без модели.
 *   Уровень 2 (~150 токенов): дешёвый LLM-роутер (generateObject) выбирает
 *     интент из каталога — ответ по-прежнему считает SQL, модель не пишет текст.
 *   Уровень 3 (полный агент): только сложные вопросы и мутации. Инструменты
 *     возвращают компактные агрегаты; изменения — ТОЛЬКО через propose_*
 *     (pendingAction подтверждается кнопкой, исполняется отдельным action).
 *
 * ВАЖНО (AGENTS.md §4): модуль — admin-видимая поверхность и не импортирует
 * скрытые подсистемы владельца; закреплено в lib/ai/isolation.test.ts.
 */

import { generateObject, generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import {
  getSourceDetail,
  getSourcesOverview,
  listSources,
  type Source,
} from '@/lib/data/sources'
import { query } from '@/lib/db'
import { isBrainConfigured } from '@/lib/ai/brain/core'
import {
  classifyOverviewQuery,
  matchSourceName,
  parsePeriod,
  type OverviewIntent,
  type ParsedPeriod,
} from './intents'
import { executeIntent, type HandlerContext } from './handlers'
import type {
  OverviewAiResult,
  PendingOverviewAction,
} from './types'
import { describePendingAction } from './types'

/** Дешёвая модель для роутинга (~150 токенов на вызов). */
const ROUTER_MODEL = process.env.AI_OVERVIEW_ROUTER_MODEL || 'openai/gpt-4.1-nano'
/** Полная модель для агента — та же, что у чат-ассистента по умолчанию. */
const AGENT_MODEL = process.env.AI_OVERVIEW_AGENT_MODEL || 'openai/gpt-4.1'

export interface OverviewAiOptions {
  /** Период, выбранный на вкладке (используется, если в тексте нет своего). */
  fallbackPeriod: ParsedPeriod
  tzOffsetMinutes: number
}

/* ------------------------------------------------------------------ */
/* Уровень 2: дешёвый LLM-роутер                                       */
/* ------------------------------------------------------------------ */

const ROUTABLE = ['summary', 'top_sources', 'source_stats', 'money', 'leads', 'help'] as const

const routerSchema = z.object({
  intent: z
    .enum([...ROUTABLE, 'complex', 'reject'])
    .describe('Интент вопроса, complex для сложных/мутаций, reject для оффтопа'),
  periodDays: z
    .number()
    .nullable()
    .describe('Период в днях, если явно указан в вопросе (сегодня=1, неделя=7)'),
  sourceName: z
    .string()
    .nullable()
    .describe('Название источника из вопроса, если упомянуто'),
})

const ROUTER_INTENT_DOC = [
  'summary — общая сводка, «как дела»',
  'top_sources — сравнение/рейтинг источников',
  'source_stats — цифры одного конкретного источника',
  'money — расходы, пополнения, балансы',
  'leads — лиды, воронка, передачи',
  'help — что умеет строка',
  'complex — сложный анализ, причины, сравнения периодов, любые ИЗМЕНЕНИЯ данных',
  'reject — не про источники/трафик/лидов/финансы/менеджеров',
].join('\n')

async function routeWithLlm(
  question: string,
  sources: Pick<Source, 'id' | 'name'>[],
): Promise<z.infer<typeof routerSchema> | null> {
  try {
    const { object } = await generateObject({
      model: ROUTER_MODEL,
      schema: routerSchema,
      system:
        `Роутер запросов дашборда источников трафика. Выбери интент:\n${ROUTER_INTENT_DOC}\n` +
        `Источники: ${sources.map((s) => s.name).join(', ') || '(нет)'}`,
      prompt: question,
      maxOutputTokens: 200,
    })
    return object
  } catch {
    return null
  }
}

function periodFromDays(days: number, now = new Date()): ParsedPeriod {
  const n = Math.min(365, Math.max(1, Math.round(days)))
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const to = new Date(todayStart)
  to.setDate(to.getDate() + 1)
  const from = new Date(todayStart)
  from.setDate(from.getDate() - (n - 1))
  return {
    fromISO: from.toISOString(),
    toISO: to.toISOString(),
    label: n === 1 ? 'сегодня' : `за ${n} дн.`,
  }
}

/* ------------------------------------------------------------------ */
/* Уровень 3: полный агент с инструментами                             */
/* ------------------------------------------------------------------ */

const PROPOSE_NOTE =
  'Действие НЕ выполнено — оно будет показано пользователю кнопкой подтверждения. Сообщи об этом кратко.'

function buildAgentTools(state: {
  pending: PendingOverviewAction | null
  opts: OverviewAiOptions
}) {
  return {
    list_sources: tool({
      description:
        'Все источники трафика с их каналами. Также возвращает каналы без источника.',
      inputSchema: z.object({}),
      execute: async () => {
        const sources = await listSources()
        const unassigned = await query<{ id: string; name: string; type: string }>(
          `SELECT ch.id, ch.name, ch.type
             FROM channels ch
             LEFT JOIN source_channels sc ON sc.channel_id = ch.id
            WHERE sc.channel_id IS NULL AND ch.type <> 'telegram_personal'
            ORDER BY ch.name ASC`,
        )
        return {
          sources: sources.map((s) => ({
            id: s.id,
            name: s.name,
            channels: s.channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
          })),
          channelsWithoutSource: unassigned,
        }
      },
    }),
    sources_overview: tool({
      description:
        'Сводная статистика всех источников за период: люди, воронка лидов, деньги, динамика по дням.',
      inputSchema: z.object({
        days: z.number().min(1).max(180).describe('Период в днях'),
      }),
      execute: async ({ days }) => {
        const p = periodFromDays(days)
        const o = await getSourcesOverview(p.fromISO, p.toISO, state.opts.tzOffsetMinutes)
        return {
          period: p.label,
          sources: o.items.map((s) => ({
            id: s.id,
            name: s.name,
            people: s.stats.people,
            handoff: s.stats.handoff,
            liquid: s.stats.liquid,
            transferred: s.stats.transferred,
            income: s.stats.income,
            expense: s.stats.expense,
            currency: s.currency,
          })),
          withoutSource: o.unassigned
            ? { people: o.unassigned.stats.people, transferred: o.unassigned.stats.transferred }
            : null,
        }
      },
    }),
    source_detail: tool({
      description:
        'Детали одного источника за период: трафик по каналам/дням, воронка, финансы.',
      inputSchema: z.object({
        sourceId: z.string().describe('ID источника из list_sources'),
        days: z.number().min(1).max(180).describe('Период в днях'),
      }),
      execute: async ({ sourceId, days }) => {
        const p = periodFromDays(days)
        const d = await getSourceDetail(sourceId, p.fromISO, p.toISO, state.opts.tzOffsetMinutes)
        if (!d) return { error: 'Источник не найден' }
        return {
          name: d.name,
          period: p.label,
          funnel: d.funnel,
          finance: d.finance,
          byChannel: d.traffic.byChannel.map((c) => ({
            name: c.name,
            people: c.people,
            messages: c.messages,
          })),
        }
      },
    }),
    manager_stats: tool({
      description: 'Активные менеджеры: диалоги и лиды за период.',
      inputSchema: z.object({
        days: z.number().min(1).max(180).describe('Период в днях'),
      }),
      execute: async ({ days }) => {
        const rows = await query<{ name: string; dialogs: string; leads: string }>(
          `SELECT m.name,
                  COUNT(DISTINCT c.id) AS dialogs,
                  COUNT(DISTINCT c.id) FILTER (
                    WHERE c.status IN ('handoff', 'liquid', 'transferred')
                  ) AS leads
             FROM managers m
             LEFT JOIN conversations c
               ON c.manager_id = m.id
              AND c.created_at >= NOW() - make_interval(days => $1)
            WHERE m.status = 'active'
            GROUP BY m.id, m.name
            ORDER BY dialogs DESC
            LIMIT 25`,
          [days],
        )
        return rows.map((r) => ({
          name: r.name,
          dialogs: Number(r.dialogs),
          leads: Number(r.leads),
        }))
      },
    }),
    propose_rename_source: tool({
      description: `Предложить переименование источника. ${PROPOSE_NOTE}`,
      inputSchema: z.object({
        sourceId: z.string(),
        sourceName: z.string().describe('Текущее имя'),
        newName: z.string().min(1).max(120),
      }),
      execute: async ({ sourceId, sourceName, newName }) => {
        state.pending = { type: 'rename_source', sourceId, sourceName, newName }
        return { proposed: true }
      },
    }),
    propose_delete_source: tool({
      description: `Предложить удаление источника (вместе с финансами). ${PROPOSE_NOTE}`,
      inputSchema: z.object({
        sourceId: z.string(),
        sourceName: z.string(),
      }),
      execute: async ({ sourceId, sourceName }) => {
        state.pending = { type: 'delete_source', sourceId, sourceName }
        return { proposed: true }
      },
    }),
    propose_create_source: tool({
      description: `Предложить создание нового источника, опционально с каналами. ${PROPOSE_NOTE}`,
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        channelIds: z.array(z.string()).describe('ID каналов из list_sources, можно пустой'),
        channelNames: z.array(z.string()).describe('Имена этих каналов, в том же порядке'),
      }),
      execute: async ({ name, channelIds, channelNames }) => {
        state.pending = { type: 'create_source', name, channelIds, channelNames }
        return { proposed: true }
      },
    }),
    propose_set_source_channels: tool({
      description:
        `Предложить новый ПОЛНЫЙ состав каналов источника (перенос канала = ` +
        `set у принимающего источника с добавленным каналом). ${PROPOSE_NOTE}`,
      inputSchema: z.object({
        sourceId: z.string(),
        sourceName: z.string(),
        channelIds: z.array(z.string()),
        channelNames: z.array(z.string()),
      }),
      execute: async ({ sourceId, sourceName, channelIds, channelNames }) => {
        state.pending = {
          type: 'set_source_channels',
          sourceId,
          sourceName,
          channelIds,
          channelNames,
        }
        return { proposed: true }
      },
    }),
  }
}

async function runAgent(
  question: string,
  opts: OverviewAiOptions,
): Promise<OverviewAiResult> {
  const state: { pending: PendingOverviewAction | null; opts: OverviewAiOptions } = {
    pending: null,
    opts,
  }

  const { text } = await generateText({
    model: AGENT_MODEL,
    system:
      `Ты — аналитик дашборда «Обзор» панели ИИ-продавца. Отвечай руководителю кратко, на русском.\n` +
      `Правила:\n` +
      `1. Цифры — только из инструментов, ничего не выдумывай.\n` +
      `2. Ответ — 1-4 предложения или компактный список. Без markdown-таблиц.\n` +
      `3. Изменения — ТОЛЬКО через propose_*: пользователь подтвердит кнопкой.\n` +
      `4. Не более 3 вызовов инструментов. Не запрашивай одно и то же дважды.\n` +
      `5. Оффтоп (не источники/трафик/лиды/финансы/менеджеры) — вежливый отказ одной фразой.`,
    prompt: question,
    tools: buildAgentTools(state),
    stopWhen: stepCountIs(5),
    maxOutputTokens: 700,
  })

  if (state.pending) {
    return {
      ok: true,
      level: 3,
      answer: {
        kind: 'confirm',
        title: 'Требуется подтверждение',
        description: text?.trim() || describePendingAction(state.pending),
        action: state.pending,
      },
    }
  }

  return {
    ok: true,
    level: 3,
    answer: {
      kind: 'text',
      text: text?.trim() || 'Не удалось сформировать ответ. Попробуйте переформулировать.',
    },
  }
}

/* ------------------------------------------------------------------ */
/* Публичная точка входа каскада                                       */
/* ------------------------------------------------------------------ */

export async function runOverviewAi(
  question: string,
  opts: OverviewAiOptions,
): Promise<OverviewAiResult> {
  const q = question.trim()
  if (!q) return { ok: false, level: 1, message: 'Пустой запрос.' }

  const sources = await listSources()
  const period = parsePeriod(q) ?? opts.fallbackPeriod
  const matched = matchSourceName(q, sources)
  const ctx: HandlerContext = {
    period,
    tzOffsetMinutes: opts.tzOffsetMinutes,
    sourceId: matched?.id ?? null,
  }

  // Уровень 1: детерминированная классификация — 0 токенов.
  const cls = classifyOverviewQuery(q)
  if (cls.confident && cls.intent !== 'unknown') {
    const answer = await executeIntent(cls.intent, ctx)
    if (answer) return { ok: true, level: 1, answer }
  }

  // Быстрый путь: назван только источник («авито») — открываем его карточку.
  if (matched && cls.intent === 'unknown') {
    return {
      ok: true,
      level: 1,
      answer: { kind: 'open_source', title: matched.name, sourceId: matched.id },
    }
  }

  // Дальше нужна модель. Без ключа — честный оффлайн-фолбэк.
  if (!isBrainConfigured()) {
    if (cls.intent !== 'unknown') {
      const answer = await executeIntent(cls.intent, ctx)
      if (answer) return { ok: true, level: 1, answer }
    }
    return {
      ok: false,
      level: 1,
      message:
        'ИИ не настроен (нет AI_GATEWAY_API_KEY). Доступны простые запросы: «сводка», «топ источников», «деньги», «лиды», имя источника.',
    }
  }

  // Уровень 2: дешёвый роутер.
  const routed = await routeWithLlm(q, sources)
  if (routed) {
    if (routed.intent === 'reject') {
      return {
        ok: true,
        level: 2,
        answer: {
          kind: 'text',
          text: 'Я помогаю с обзором источников, трафика, лидов, финансов и менеджеров. Для настройки ИИ-продавца используйте чат-ассистент.',
        },
      }
    }
    if (routed.intent !== 'complex') {
      const routedSource = routed.sourceName
        ? matchSourceName(routed.sourceName, sources)
        : matched
      const routedCtx: HandlerContext = {
        period: routed.periodDays ? periodFromDays(routed.periodDays) : period,
        tzOffsetMinutes: opts.tzOffsetMinutes,
        sourceId: routedSource?.id ?? null,
      }
      const answer = await executeIntent(routed.intent as OverviewIntent, routedCtx)
      if (answer) return { ok: true, level: 2, answer }
    }
  }

  // Уровень 3: полный агент — только для сложного.
  return runAgent(q, opts)
}
