import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import { generateManagerReply } from '@/lib/ai/manager-brain'
import {
  getAiAssistSettings,
  listBrainLessons,
  retrieveKnowledge,
} from '@/lib/data/ai-assist'
import { directiveTexts } from '@/lib/data/ai-directives'
import {
  addCheckCase,
  addCopilotNote,
  deleteCheckCase,
  deleteCopilotNote,
  listCheckCases,
  listCopilotNotes,
} from '@/lib/data/ai-copilot'
import {
  getActiveExperiment,
  getExperimentResults,
  stopExperiment as stopExperimentData,
} from '@/lib/data/ai-experiments'
import { truncate, type RunState } from './run-state'

/**
 * Quality-assurance tools: reply preview against the REAL seller brain, saved
 * check cases (+ batch runs), the co-pilot's long-term business memory, and
 * the A/B experiment lifecycle. Starting an experiment and adopting branch B
 * are guarded (needsConfirmation) — both change live client conversations.
 */
export function qualityTools(state: RunState) {
  return {
    previewReply: tool({
      description:
        'Показать, ЧТО ИМЕННО ответит клиенту ИИ-менеджер прямо сейчас, с текущими настройками, персоной и правилами — но НЕ отправляя ничего клиенту. Вызывай, когда админ спрашивает «а что ты ответишь, если клиент скажет…», «покажи ответ на…», «как ты отработаешь возражение…». Передай clientMessage — реплику клиента. Это настоящий ответ того же мозга, что пишет живым клиентам, поэтому по нему видно, как сработают правила.',
      inputSchema: z.object({
        clientMessage: z.string().min(1).max(2000),
      }),
      execute: async ({ clientMessage }) => {
        const msg = clientMessage.trim()
        const [settings, lessons, directives, knowledge] = await Promise.all([
          getAiAssistSettings(),
          listBrainLessons(12),
          directiveTexts(),
          retrieveKnowledge(msg, 4),
        ])
        const reply = await generateManagerReply(
          {
            persona: settings.persona,
            tone: settings.tone,
            playbook: settings.playbook,
            directives,
            lessons,
            knowledge,
            aggressiveness: settings.aggressiveness,
            history: [{ role: 'client', body: msg }],
          },
          undefined,
          {
            model: settings.model,
            temperature: settings.temperature,
            maxTokens: settings.maxTokens,
          },
        )
        if (!reply) return { ok: false, reason: 'no_reply' }
        return { ok: true, clientMessage: msg, reply }
      },
    }),

    rememberBusinessNote: tool({
      description:
        'Записать в ДОЛГУЮ ПАМЯТЬ важный факт о бизнесе админа, который пригодится в будущих разговорах: специфика продукта, сезонность, типовые клиенты, договорённости («у нас пик продаж в декабре», «основной клиент — оптовики»). Это память ДЛЯ ТЕБЯ (ассистента), а не правило для продавца — правила сохраняй через rememberDirective. Вызывай, когда админ рассказывает о бизнесе что-то важное и долгоиграющее, либо прямо просит «запомни на будущее». Формулируй кратко, одним предложением.',
      inputSchema: z.object({ body: z.string().min(1).max(1000) }),
      execute: async ({ body }) => {
        const res = await addCopilotNote(body)
        if (!res.ok) return res
        state.actions.push({
          kind: 'memory',
          label: `Запомнил о бизнесе: «${truncate(body, 60)}»`,
        })
        return res
      },
    }),

    listBusinessNotes: tool({
      description:
        'Показать всё, что ты помнишь о бизнесе админа (долгая память ассистента). Вызывай, когда админ спрашивает «что ты про нас помнишь», «что ты знаешь о моём бизнесе», или перед удалением заметки — чтобы взять id.',
      inputSchema: z.object({}),
      execute: async () => {
        const notes = await listCopilotNotes()
        return {
          ok: true,
          count: notes.length,
          notes: notes.map((n) => ({ id: n.id, body: n.body, at: n.createdAt })),
        }
      },
    }),

    forgetBusinessNote: tool({
      description:
        'Удалить заметку из долгой памяти о бизнесе (устарела или админ просит забыть). Сначала возьми id через listBusinessNotes.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const ok = await deleteCopilotNote(id)
        if (!ok) return { ok: false, reason: 'not_found' }
        state.actions.push({ kind: 'memory', label: 'Забыл заметку о бизнесе' })
        return { ok: true }
      },
    }),

    addCheckCase: tool({
      description:
        'Сохранить проверочный вопрос для продавца: реплика клиента + что ХОРОШИЙ ответ обязан сделать («клиент: дорого → должен предложить рассрочку, не давать скидку сверх 10%»). Набор таких проверок гоняется через runCheckCases после изменений правил, чтобы ловить поломки. Вызывай, когда админ говорит «добавь проверку», «пусть это всегда проверяется», или сам предложи сохранить проверку после того, как админ отладил важный ответ через previewReply.',
      inputSchema: z.object({
        clientMessage: z.string().min(1).max(2000),
        expectation: z.string().min(1).max(1000),
      }),
      execute: async ({ clientMessage, expectation }) => {
        const res = await addCheckCase({ clientMessage, expectation })
        if (!res.ok) return res
        state.actions.push({
          kind: 'check',
          label: `Проверка: «${truncate(clientMessage, 50)}»`,
        })
        return res
      },
    }),

    listCheckCases: tool({
      description:
        'Показать сохранённые проверочные вопросы для продавца. Вызывай, когда админ спрашивает «какие проверки есть», или перед удалением проверки — чтобы взять id.',
      inputSchema: z.object({}),
      execute: async () => {
        const cases = await listCheckCases(false)
        return {
          ok: true,
          count: cases.length,
          cases: cases.map((c) => ({
            id: c.id,
            clientMessage: c.clientMessage,
            expectation: c.expectation,
            enabled: c.enabled,
          })),
        }
      },
    }),

    deleteCheckCase: tool({
      description:
        'Удалить проверочный вопрос навсегда. Сначала возьми id через listCheckCases и убедись, что админ хочет убрать именно его.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const ok = await deleteCheckCase(id)
        if (!ok) return { ok: false, reason: 'not_found' }
        state.actions.push({ kind: 'check', label: 'Удалил проверку' })
        return { ok: true }
      },
    }),

    runCheckCases: tool({
      description:
        'Прогнать сохранённые проверочные вопросы через НАСТОЯЩИЙ мозг продавца с текущими правилами и вернуть пары «вопрос клиента → фактический ответ → что требовалось». Клиентам ничего не отправляется. Вызывай ПОСЛЕ изменений правил/персоны/агрессивности, когда админ просит «проверь, ничего не сломалось», или предложи сам после крупной правки. Получив результаты, САМ сверь каждый ответ с ожиданием и доложи: какие проверки прошли, какие провалились и почему — с конкретной цитатой из ответа.',
      inputSchema: z.object({}),
      execute: async () => {
        const cases = (await listCheckCases(true)).slice(0, 6)
        if (cases.length === 0) return { ok: true, ran: 0, results: [] }
        const settings = await getAiAssistSettings()
        const [lessons, directives] = await Promise.all([
          listBrainLessons(12),
          directiveTexts(),
        ])
        const results: Array<{
          clientMessage: string
          expectation: string
          reply: string | null
        }> = []
        // Sequential on purpose: each run is a real model call; parallel bursts
        // would spike latency limits and Gateway spend for no benefit here.
        for (const c of cases) {
          const knowledge = await retrieveKnowledge(c.clientMessage, 4).catch(
            () => '',
          )
          const reply = await generateManagerReply(
            {
              persona: settings.persona,
              tone: settings.tone,
              playbook: settings.playbook,
              directives,
              lessons,
              knowledge,
              aggressiveness: settings.aggressiveness,
              history: [{ role: 'client', body: c.clientMessage }],
            },
            undefined,
            {
              model: settings.model,
              temperature: settings.temperature,
              maxTokens: settings.maxTokens,
            },
          ).catch(() => null)
          results.push({
            clientMessage: c.clientMessage,
            expectation: c.expectation,
            reply,
          })
        }
        state.actions.push({
          kind: 'check',
          label: `Прогнал ${results.length} провер${results.length === 1 ? 'ку' : 'ок'} продавца`,
        })
        return { ok: true, ran: results.length, results }
      },
    }),

    startExperiment: tool({
      description:
        'Запустить A/B-эксперимент над продавцом: половина клиентов остаётся на текущих настройках (ветка А, контроль), половина получает вариант (ветка Б) — другую персону, тон, агрессивность и/или дополнительное правило. Клиент детерминированно закрепляется за веткой на весь диалог во всех каналах. Одновременно может идти только ОДИН эксперимент. Вызывай, когда админ говорит «попробуй на половине клиентов…», «проверь, что сработает лучше», «запусти эксперимент». Запуск требует подтверждения (вернётся needsConfirmation) — эксперимент меняет живое общение с реальными клиентами. Передавай только те поля варианта, которые реально меняются.',
      inputSchema: z.object({
        name: z.string().min(1).max(200),
        persona: z.string().max(2000).optional(),
        tone: z.enum(['professional', 'friendly', 'persuasive']).optional(),
        aggressiveness: z.number().int().min(0).max(3).optional(),
        extraDirective: z.string().max(1000).optional(),
      }),
      execute: async ({ name, persona, tone, aggressiveness, extraDirective }) => {
        const existing = await getActiveExperiment()
        if (existing) {
          return {
            ok: false,
            reason: 'already_active',
            activeName: existing.name,
          }
        }
        if (
          persona === undefined &&
          tone === undefined &&
          aggressiveness === undefined &&
          extraDirective === undefined
        ) {
          return { ok: false, reason: 'empty_overrides' }
        }
        // Aggressiveness 3 inside an experiment is the same ethical threshold
        // as setAggressiveness(3) — it must not sneak past the guard via B.
        const overrides = { persona, tone, aggressiveness, extraDirective }
        state.pending = {
          kind: 'start_experiment',
          label: `Запустить эксперимент «${truncate(name, 60)}»`,
          detail:
            aggressiveness === 3
              ? 'Половина клиентов получит вариант Б, включая МАКСИМАЛЬНЫЙ дожим (уровень 3). Контрольная половина останется как есть.'
              : 'Половина реальных клиентов начнёт получать ответы с настройками варианта Б. Контрольная половина останется как есть.',
          payload: { name, overrides },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),

    getExperimentStatus: tool({
      description:
        'Показать текущий (или последний завершённый) A/B-эксперимент и его результаты по веткам: сколько диалогов, сколько ликвидных лидов и передач человеку в контроле (А) и в варианте (Б). Вызывай на вопросы «как идёт эксперимент», «какая ветка побеждает», «что показал тест». Делай честный вывод: при малой выборке (меньше ~20 диалогов на ветку) прямо говори, что данных пока мало для решения.',
      inputSchema: z.object({}),
      execute: async () => {
        const results = await getExperimentResults()
        if (!results) return { ok: true, experiment: null }
        return { ok: true, ...results }
      },
    }),

    stopExperiment: tool({
      description:
        'Остановить активный A/B-эксперимент. winner — какая ветка победила («A», «B» или не передавай, если ничья/просто остановка). Остановка с победителем А или без победителя применяется сразу: все клиенты возвращаются на основные настройки. Если победила ветка Б и админ хочет ПРИНЯТЬ её настройки как основные — это требует подтверждения (needsConfirmation), потому что меняет продавца для всех клиентов. Вызывай, когда админ говорит «останови эксперимент», «принимаем вариант Б», «оставляем как было».',
      inputSchema: z.object({
        winner: z.enum(['A', 'B']).optional(),
        /** true = победившие настройки Б станут основными для всех. */
        adoptWinner: z.boolean().optional(),
      }),
      execute: async ({ winner, adoptWinner }) => {
        const active = await getActiveExperiment()
        if (!active) return { ok: false, reason: 'no_active' }
        if (winner === 'B' && adoptWinner) {
          state.pending = {
            kind: 'adopt_experiment_winner',
            label: `Принять вариант Б эксперимента «${truncate(active.name, 50)}»`,
            detail:
              'Эксперимент остановится, и настройки победившей ветки Б станут основными для ВСЕХ клиентов.',
            payload: { overrides: active.overrides },
          }
          return { ok: true, needsConfirmation: true }
        }
        const res = await stopExperimentData(winner ?? null)
        if (!res.ok) return res
        state.actions.push({
          kind: 'experiment',
          label: `Остановил эксперимент «${truncate(res.experiment.name, 50)}»${winner ? ` — победа ветки ${winner}` : ''}`,
        })
        return { ok: true, stopped: res.experiment.name, winner: winner ?? null }
      },
    }),
  }
}
