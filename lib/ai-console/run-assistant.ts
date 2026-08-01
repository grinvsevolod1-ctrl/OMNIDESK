import 'server-only'
import { ToolLoopAgent, tool, isStepCount } from 'ai'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import {
  analyzeDialogsForLessons,
  analyzeLossPatterns,
  generateManagerReply,
  generateSalesScenario,
  isBrainConfigured,
} from '@/lib/ai/manager-brain'
import { getDealHeat, listDealHeat } from '@/lib/ai/deal-heat'
import {
  getAiAssistSettings,
  updateAiAssistSettings,
  listKnowledge,
  upsertKnowledge,
  deleteKnowledge,
  addLesson,
  deleteLesson,
  listBrainLessons,
  listLessons,
  countLessons,
  listAiEnrolledConversations,
  listEnrollableConversations,
  enrollConversationAi,
  unenrollConversationAi,
  getAiModelStats,
  retrieveKnowledge,
} from '@/lib/data/ai-assist'
import {
  getAiPerformanceSummary,
  getAiPerformanceTrend,
  getDialogTranscript,
  listLostDialogs,
  listUnderperformingDialogs,
} from '@/lib/data/ai-analytics'
import {
  getActiveExperiment,
  getExperimentResults,
  stopExperiment as stopExperimentData,
} from '@/lib/data/ai-experiments'
import { getSystemHealth } from '@/lib/data/ai-health'
import {
  addCheckCase,
  addCopilotNote,
  deleteCheckCase,
  deleteCopilotNote,
  listCheckCases,
  listCopilotNotes,
} from '@/lib/data/ai-copilot'
import {
  getFollowupSettings,
  updateFollowupSettings,
} from '@/lib/data/ai-followup'
import { countManualCorrections } from '@/lib/data/ai-assist-corrections'
import {
  addDirective,
  countDirectives,
  directiveTexts,
  listDirectives,
  removeDirective,
  reorderDirectives,
  setDirectiveEnabled,
  updateDirective,
} from '@/lib/data/ai-directives'
import { listAiLogs } from '@/lib/data/ai-log'
import { classifyByKeywords, type ConsoleIntent } from './intents'
import {
  AGGRESSIVENESS_LABELS,
  ASSISTANT_HISTORY_LIMIT,
  type AssistantReport,
  type AssistantResult,
  type AssistantTurn,
  type ExecutedAction,
  type PendingConfirmation,
  type SettingsRevert,
} from './assistant'

/**
 * Shared orchestration for the AI-manager co-pilot, used by BOTH the server
 * action (non-streaming) and the streaming route handler. Keeping it in one
 * place means the tools, scope-lock prompt, guarded actions and offline
 * fallback can never drift between the two entry points.
 */

const ASSISTANT_MODEL =
  process.env.AI_CONSOLE_ASSISTANT_MODEL || 'openai/gpt-4.1'

export const AI_PATH = '/admin/ai'

/** Normalize raw client history into clean model turns. */
export function normalizeTurns(
  history: AssistantTurn[] | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return (history ?? [])
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .slice(-ASSISTANT_HISTORY_LIMIT)
    .map((t) => ({
      role:
        t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: t.content.trim().slice(0, 2000),
    }))
}

/** Shorten a string for a receipt-chip label, adding an ellipsis if cut. */
function truncate(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** Russian plural for "правило" (rule) by count: 1 правило, 2 правила, 5 правил. */
function pluralRules(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'правило'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'правила'
  return 'правил'
}

/** The latest user utterance from a normalized turn list. */
export function lastUserText(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  return [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''
}

/** Natural acknowledgement per panel for the deterministic fallback path. */
export function fallbackReply(intent: ConsoleIntent): string {
  switch (intent) {
    case 'settings':
      return 'Открываю настройки ИИ-менеджера.'
    case 'aggressiveness':
      return 'Открываю настройку агрессивности продаж.'
    case 'knowledge':
      return 'Открываю базу знаний.'
    case 'training':
      return 'Открываю обучение ассистента.'
    case 'corrections':
      return 'Открываю правки и правила.'
    case 'dialogs':
      return 'Открываю диалоги под управлением ИИ.'
    case 'logs':
      return 'Открываю логи и диагностику.'
    default:
      return 'Пока ИИ-ключ не настроен, я открою нужный раздел — а полноценно поговорить сможем, когда появится доступ к модели.'
  }
}

/** Compact status string the model reads to ground its answers. */
async function readStatus() {
  const [settings, knowledge, lessons, corrections, enrolled, directives] =
    await Promise.all([
      getAiAssistSettings(),
      listKnowledge(),
      countLessons(),
      countManualCorrections(),
      listAiEnrolledConversations(),
      countDirectives(),
    ])
  return {
    enabled: settings.enabled,
    tone: settings.tone,
    persona: settings.persona || '(не задано)',
    aggressiveness: settings.aggressiveness,
    aggressivenessLabel:
      AGGRESSIVENESS_LABELS[settings.aggressiveness] ?? 'Сбалансированный',
    model: settings.model || '(по умолчанию)',
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    knowledgeCount: knowledge.length,
    lessonCount: lessons,
    correctionCount: corrections,
    enrolledDialogs: enrolled.length,
    directiveCount: directives,
  }
}

/**
 * Build the tool-calling agent plus the per-turn accumulators. High-impact
 * actions (disabling the AI, maxing aggressiveness) are GUARDED: instead of
 * applying, they record a `pending` confirmation the UI must approve. The
 * return type is intentionally inferred (the agent's tool-set type is complex);
 * callers get `{ agent, messages, finalize }`.
 */
export async function prepareAssistantRun(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
  const actions: ExecutedAction[] = []
  let openPanel: ConsoleIntent | null = null
  let settingsChanged = false
  let pending: PendingConfirmation | null = null
  let report: AssistantReport | null = null

  // Pre-turn snapshot so each mutation can attach a one-click revert patch.
  const baseline = await getAiAssistSettings()

  const tools = {
    getStatus: tool({
      description:
        'Прочитать текущее состояние ИИ-менеджера: включён ли он, тон, персона, уровень агрессивности, модель, счётчики базы знаний/уроков/правок/диалогов. Вызывай перед тем, как что-то объяснять или менять.',
      inputSchema: z.object({}),
      execute: async () => readStatus(),
    }),

    setEnabled: tool({
      description:
        'Включить ИИ-менеджера (главный переключатель). Для ВЫКЛЮЧЕНИЯ передай enabled=false — но выключение требует подтверждения администратора, оно не применится сразу, а вернёт needsConfirmation.',
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: async ({ enabled }) => {
        // Guard: disabling the AI is high-impact → require confirmation.
        if (!enabled) {
          pending = {
            kind: 'disable',
            label: 'Выключить ИИ-менеджера',
            detail:
              'После выключения ИИ перестанет отвечать клиентам во всех диалогах.',
          }
          return { ok: true, needsConfirmation: true }
        }
        await updateAiAssistSettings({ enabled: true })
        settingsChanged = true
        actions.push({
          kind: 'enabled',
          label: 'Включил ИИ-менеджера',
          revert: { enabled: baseline.enabled },
        })
        return { ok: true, enabled: true }
      },
    }),

    setTone: tool({
      description:
        'Сменить тон общения ИИ-менеджера. professional — деловой, friendly — дружелюбный, persuasive — убедительный/продающий.',
      inputSchema: z.object({
        tone: z.enum(['professional', 'friendly', 'persuasive']),
      }),
      execute: async ({ tone }) => {
        await updateAiAssistSettings({ tone })
        settingsChanged = true
        const label =
          tone === 'professional'
            ? 'деловой'
            : tone === 'friendly'
              ? 'дружелюбный'
              : 'убедительный'
        actions.push({
          kind: 'tone',
          label: `Тон → ${label}`,
          revert: { tone: baseline.tone },
        })
        return { ok: true, tone }
      },
    }),

    setPersona: tool({
      description:
        'Задать описание компании/персоны ИИ-менеджера (чем занимается компания, как себя вести, что предлагать). Полностью перезаписывает текущее описание.',
      inputSchema: z.object({
        persona: z.string().min(1).max(2000),
      }),
      execute: async ({ persona }) => {
        await updateAiAssistSettings({ persona: persona.trim() })
        settingsChanged = true
        actions.push({
          kind: 'persona',
          label: 'Обновил описание компании',
          revert: { persona: baseline.persona },
        })
        return { ok: true }
      },
    }),

    generateScenario: tool({
      description:
        'Собрать ИИ-продавца «с нуля» по описанию бизнеса. Вызывай, когда админ описывает свою компанию/продукт и просит «настрой продавца», «сделай сценарий», «собери под мой бизнес». Модель сгенерирует персону (сценарий) и набор правил, применит персону (перезаписав старую) и сохранит правила как прямые указания. Передай businessDescription — всё, что админ рассказал о бизнесе.',
      inputSchema: z.object({
        businessDescription: z.string().min(10).max(4000),
      }),
      execute: async ({ businessDescription }) => {
        const scenario = await generateSalesScenario(businessDescription.trim())
        if (!scenario) {
          return { ok: false, reason: 'generation_unavailable' }
        }
        if (scenario.persona) {
          await updateAiAssistSettings({ persona: scenario.persona })
          settingsChanged = true
          actions.push({
            kind: 'persona',
            label: 'Собрал сценарий продавца под бизнес',
            revert: { persona: baseline.persona },
          })
        }
        let savedDirectives = 0
        for (const body of scenario.directives) {
          try {
            await addDirective(body)
            savedDirectives += 1
          } catch {
            /* cap reached or empty — skip, best-effort */
          }
        }
        if (savedDirectives > 0) {
          actions.push({
            kind: 'directive',
            label: `Добавил ${savedDirectives} ${pluralRules(savedDirectives)} под бизнес`,
          })
        }
        return {
          ok: true,
          personaSet: !!scenario.persona,
          directivesAdded: savedDirectives,
          persona: scenario.persona,
          directives: scenario.directives,
        }
      },
    }),

    setAggressiveness: tool({
      description:
        'Настроить, насколько жёстко ИИ дожимает клиента до цели. 0 — мягкий, 1 — сбалансированный, 2 — напористый, 3 — максимальный дожим. Уровень 3 требует подтверждения администратора и не применится сразу.',
      inputSchema: z.object({
        level: z.number().int().min(0).max(3),
      }),
      execute: async ({ level }) => {
        // Guard: maximum pressure is high-impact → require confirmation.
        if (level === 3) {
          pending = {
            kind: 'max_aggressiveness',
            label: 'Включить максимальный дожим',
            detail:
              'Уровень 3 — предельное давление на клиента вплоть до передачи документов.',
          }
          return { ok: true, needsConfirmation: true }
        }
        await updateAiAssistSettings({ aggressiveness: level })
        settingsChanged = true
        actions.push({
          kind: 'aggressiveness',
          label: `Агрессивность → ${AGGRESSIVENESS_LABELS[level]}`,
          revert: { aggressiveness: baseline.aggressiveness },
        })
        return { ok: true, level, label: AGGRESSIVENESS_LABELS[level] }
      },
    }),

    setModelParams: tool({
      description:
        'Настроить параметры модели ИИ-менеджера: temperature (0..2, креативность) и maxTokens (длина ответа). Меняй только то, что попросил админ.',
      inputSchema: z.object({
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(50).max(4000).optional(),
      }),
      execute: async ({ temperature, maxTokens }) => {
        if (temperature == null && maxTokens == null) {
          return { ok: false, reason: 'nothing_to_change' }
        }
        await updateAiAssistSettings({
          temperature: temperature ?? undefined,
          maxTokens: maxTokens ?? undefined,
        })
        settingsChanged = true
        const parts: string[] = []
        const revert: SettingsRevert = {}
        if (temperature != null) {
          parts.push(`temperature ${temperature}`)
          revert.temperature = baseline.temperature
        }
        if (maxTokens != null) {
          parts.push(`ответ ${maxTokens} токенов`)
          revert.maxTokens = baseline.maxTokens
        }
        actions.push({
          kind: 'model',
          label: `Модель: ${parts.join(', ')}`,
          revert,
        })
        return { ok: true, temperature, maxTokens }
      },
    }),

    setModel: tool({
      description:
        'Сменить модель ИИ-менеджера (тот «мозг», что пишет клиентам). Вызывай, когда админ просит «поставь модель …», «сделай бота умнее/дешевле», «верни модель по умолчанию». Популярные варианты: openai/gpt-4.1 (баланс, по умолчанию), openai/gpt-4.1-mini (быстрее и дешевле), openai/gpt-5.3-chat (максимально живой). Чтобы вернуть значение по умолчанию, передай reset=true. Если админ называет модель расплывчато («поумнее»), предложи конкретный вариант и подтверди, прежде чем менять.',
      inputSchema: z.object({
        model: z.string().min(2).max(80).optional(),
        reset: z.boolean().optional(),
      }),
      execute: async ({ model, reset }) => {
        if (!reset && !model?.trim()) {
          return { ok: false, reason: 'nothing_to_change' }
        }
        const next = reset ? '' : model!.trim()
        await updateAiAssistSettings({ model: next })
        settingsChanged = true
        actions.push({
          kind: 'model',
          label: reset
            ? 'Модель: сброшена на значение по умолчанию'
            : `Модель: ${next}`,
          revert: { model: baseline.model },
        })
        return { ok: true, model: next || '(по умолчанию)' }
      },
    }),

    addKnowledge: tool({
      description:
        'Добавить точный факт в базу знаний ИИ-менеджера (цена, условие, ответ на частый вопрос). title — короткий заголовок, content — сам факт.',
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        content: z.string().min(1).max(4000),
      }),
      execute: async ({ title, content }) => {
        await upsertKnowledge({ title: title.trim(), content: content.trim() })
        actions.push({ kind: 'knowledge', label: `Факт: «${title.trim()}»` })
        return { ok: true }
      },
    }),

    listKnowledge: tool({
      description:
        'Показать всё, что сейчас лежит в базе знаний ИИ-менеджера (факты, цены, ответы на частые вопросы). Вызывай, когда админ просит «что ты знаешь», «покажи базу знаний», «какие факты сохранены», или перед тем как что-то изменить/удалить — чтобы взять id нужной записи.',
      inputSchema: z.object({}),
      execute: async () => {
        const items = await listKnowledge()
        return {
          ok: true,
          count: items.length,
          items: items.map((k) => ({
            id: k.id,
            title: k.title,
            content: truncate(k.content, 200),
            enabled: k.enabled,
          })),
        }
      },
    }),

    updateKnowledge: tool({
      description:
        'Изменить существующий факт в базе знаний: поправить текст, заголовок или временно выключить/включить его. Сначала возьми id через listKnowledge. Передай id и то, что меняешь (title / content / enabled).',
      inputSchema: z.object({
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(4000).optional(),
        enabled: z.boolean().optional(),
      }),
      execute: async ({ id, title, content, enabled }) => {
        const current = await listKnowledge()
        const entry = current.find((k) => k.id === id)
        if (!entry) return { ok: false, reason: 'not_found' }
        await upsertKnowledge({
          id,
          title: (title ?? entry.title).trim(),
          content: (content ?? entry.content).trim(),
          enabled: enabled ?? entry.enabled,
        })
        actions.push({
          kind: 'knowledge',
          label:
            enabled === false
              ? `Выключил факт: «${truncate(title ?? entry.title, 50)}»`
              : `Обновил факт: «${truncate(title ?? entry.title, 50)}»`,
        })
        return { ok: true }
      },
    }),

    deleteKnowledge: tool({
      description:
        'Удалить факт из базы знаний навсегда. Сначала возьми id через listKnowledge и убедись, что админ действительно хочет удалить именно эту запись. Передай id.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const current = await listKnowledge()
        const entry = current.find((k) => k.id === id)
        if (!entry) return { ok: false, reason: 'not_found' }
        await deleteKnowledge(id)
        actions.push({
          kind: 'knowledge',
          label: `Удалил факт: «${truncate(entry.title, 50)}»`,
        })
        return { ok: true }
      },
    }),

    addLesson: tool({
      description:
        'Добавить обучающий урок — как ИИ должен отвечать в определённой ситуации. situation — ситуация/запрос клиента, corrected — правильный ответ, note — короткое пояснение почему.',
      inputSchema: z.object({
        situation: z.string().min(1).max(1000),
        corrected: z.string().min(1).max(2000),
        note: z.string().max(500).optional(),
      }),
      execute: async ({ situation, corrected, note }) => {
        await addLesson({
          situation: situation.trim(),
          draft: '',
          corrected: corrected.trim(),
          note: (note ?? '').trim(),
        })
        actions.push({ kind: 'lesson', label: 'Добавил урок в обучение' })
        return { ok: true }
      },
    }),

    listLessons: tool({
      description:
        'Показать сохранённые обучающие уроки ИИ-менеджера (ситуация клиента → правильный ответ). Вызывай, когда админ просит «покажи уроки», «чему ты научен», или перед удалением урока — чтобы взять его id.',
      inputSchema: z.object({}),
      execute: async () => {
        const items = await listLessons(50)
        return {
          ok: true,
          count: items.length,
          items: items.map((l) => ({
            id: l.id,
            situation: truncate(l.situation, 140),
            corrected: truncate(l.corrected, 200),
            note: l.note,
          })),
        }
      },
    }),

    deleteLesson: tool({
      description:
        'Удалить обучающий урок навсегда. Сначала возьми id через listLessons и убедись, что админ хочет убрать именно его. Передай id.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const items = await listLessons(200)
        const lesson = items.find((l) => l.id === id)
        if (!lesson) return { ok: false, reason: 'not_found' }
        await deleteLesson(id)
        actions.push({
          kind: 'lesson',
          label: `Удалил урок: «${truncate(lesson.situation, 50)}»`,
        })
        return { ok: true }
      },
    }),

    rememberDirective: tool({
      description:
        'ЗАПОМНИТЬ ПРЯМОЕ УКАЗАНИЕ (правило/сценарий) для ИИ-менеджера — то, что админ диктует своими словами: «всегда сначала спрашивай бюджет», «никогда не обещай скидку больше 10%», «если упомянут конкурент — делай так». Правило durable (не стирается обучением) и попадает в КАЖДЫЙ ответ клиенту во всех каналах, включая Telegram, с высшим приоритетом. Вызывай, когда админ говорит «запомни», «правило», «всегда/никогда», «делай так», «вот сценарий». Можешь слегка причесать формулировку, не меняя смысла.',
      inputSchema: z.object({
        body: z.string().min(1).max(2000),
      }),
      execute: async ({ body }) => {
        const created = await addDirective(body.trim())
        actions.push({
          kind: 'directive',
          label: `Запомнил правило: «${truncate(created.body, 60)}»`,
        })
        return { ok: true, id: created.id, position: created.sortOrder + 1 }
      },
    }),

    listDirectives: tool({
      description:
        'Показать все прямые указания (правила/сценарии), которые сейчас помнит ИИ-менеджер, в порядке применения. Вызывай, когда админ спрашивает «какие у тебя правила», «что ты помнишь», «покажи сценарии», а ТАКЖЕ обязательно перед тем, как изменить/удалить/переставить/включить-выключить конкретное правило — чтобы взять его id.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listDirectives()
        return {
          count: rows.length,
          directives: rows.map((d, i) => ({
            position: i + 1,
            id: d.id,
            body: d.body,
            enabled: d.enabled,
          })),
        }
      },
    }),

    updateDirective: tool({
      description:
        'Изменить формулировку существующего правила. Сначала вызови listDirectives, чтобы взять id нужного правила. Полностью перезаписывает текст правила.',
      inputSchema: z.object({
        id: z.string().min(1),
        body: z.string().min(1).max(2000),
      }),
      execute: async ({ id, body }) => {
        const updated = await updateDirective(id, body.trim())
        if (!updated) return { ok: false, reason: 'not_found' }
        actions.push({
          kind: 'directive',
          label: `Изменил правило: «${truncate(updated.body, 60)}»`,
        })
        return { ok: true }
      },
    }),

    toggleDirective: tool({
      description:
        'Временно приостановить (enabled=false) или снова включить (enabled=true) правило, не удаляя его. Сначала вызови listDirectives, чтобы взять id.',
      inputSchema: z.object({
        id: z.string().min(1),
        enabled: z.boolean(),
      }),
      execute: async ({ id, enabled }) => {
        const updated = await setDirectiveEnabled(id, enabled)
        if (!updated) return { ok: false, reason: 'not_found' }
        actions.push({
          kind: 'directive',
          label: `${enabled ? 'Включил' : 'Приостановил'} правило: «${truncate(updated.body, 50)}»`,
        })
        return { ok: true }
      },
    }),

    forgetDirective: tool({
      description:
        'Насовсем удалить правило. Сначала вызови listDirectives, чтобы взять id. Удаление необратимо — если админ, возможно, захочет вернуть правило, лучше toggleDirective (приостановить).',
      inputSchema: z.object({
        id: z.string().min(1),
      }),
      execute: async ({ id }) => {
        const ok = await removeDirective(id)
        if (!ok) return { ok: false, reason: 'not_found' }
        actions.push({ kind: 'directive', label: 'Удалил правило' })
        return { ok: true }
      },
    }),

    reorderDirectives: tool({
      description:
        'Переставить правила в новом порядке приоритета (первое = самое важное). Передай orderedIds — массив id в желаемом порядке. Сначала вызови listDirectives, чтобы взять актуальные id.',
      inputSchema: z.object({
        orderedIds: z.array(z.string().min(1)).min(1),
      }),
      execute: async ({ orderedIds }) => {
        await reorderDirectives(orderedIds)
        actions.push({ kind: 'directive', label: 'Переставил порядок правил' })
        return { ok: true }
      },
    }),

    searchKnowledge: tool({
      description:
        'Найти, что ИИ-менеджер уже знает: ищет по базе знаний (факты) и обучающим урокам. Используй, когда админ спрашивает «что ты знаешь про…», «есть ли факт о…», «как ты отвечаешь на…», «чему тебя учили». Без query возвращает свежие записи.',
      inputSchema: z.object({
        query: z.string().max(200).optional(),
      }),
      execute: async ({ query }) => {
        const [knowledge, lessons] = await Promise.all([
          listKnowledge(),
          listLessons(50),
        ])
        const q = (query ?? '').trim().toLowerCase()
        const match = (s: string) => !q || s.toLowerCase().includes(q)
        // Semantic-first: the same embedding retrieval the seller brain uses,
        // so «что ты знаешь про доставку?» finds the fact even when worded
        // differently. retrieveKnowledge returns a pre-formatted bullet list
        // ('' when RAG is unavailable); substring stays as the fallback.
        let semanticHits = ''
        if (q) {
          semanticHits = await retrieveKnowledge(q, 8).catch(() => '')
        }
        const facts = semanticHits
          ? semanticHits
              .split('\n')
              .filter((line) => line.trim())
              .map((line) => ({ title: '', content: line.replace(/^•\s*/, '') }))
          : knowledge
              .filter((k) => match(k.title) || match(k.content))
              .slice(0, 8)
              .map((k) => ({ title: k.title, content: k.content }))
        const trainedOn = lessons
          .filter(
            (l) => match(l.situation) || match(l.corrected) || match(l.note),
          )
          .slice(0, 8)
          .map((l) => ({
            situation: l.situation,
            answer: l.corrected,
            note: l.note,
          }))
        return {
          query: q || null,
          factCount: facts.length,
          lessonCount: trainedOn.length,
          facts,
          lessons: trainedOn,
        }
      },
    }),

    getRecentLogs: tool({
      description:
        'Прочитать последние события из журнала ИИ-менеджера (ошибки, ответы, диагностика). Используй, когда админ спрашивает «почему ИИ молчит», «что с ошибками», «что происходит».',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(30).optional(),
      }),
      execute: async ({ limit }) => {
        const rows = await listAiLogs({ scope: 'ai', limit: limit ?? 12 })
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

    listDialogs: tool({
      description:
        'Показать диалоги: какие сейчас ведёт ИИ и какие можно ему поручить. Вызывай, когда админ спрашивает «какие диалоги на ИИ», «кого ведёт бот», «подключи ИИ к диалогу с …» (сначала найди нужный), «покажи переписки». Без search и с scope=enrolled — вернёт диалоги под управлением ИИ; со scope=all или строкой поиска — доступные для подключения (можно искать по имени контакта). Бери conversationId отсюда для attachAi/detachAi.',
      inputSchema: z.object({
        scope: z.enum(['enrolled', 'all']).optional(),
        search: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ scope, search, limit }) => {
        const cap = limit ?? 30
        const items =
          scope === 'all' || (search && search.trim())
            ? await listEnrollableConversations(search ?? '', cap)
            : await listAiEnrolledConversations(cap)
        return {
          ok: true,
          count: items.length,
          dialogs: items.map((d) => ({
            conversationId: d.conversationId,
            contact: d.contactName,
            channel: d.channelType,
            lastMessage: d.lastMessage,
            aiLed: d.enrolled,
          })),
        }
      },
    }),

    attachAi: tool({
      description:
        'Подключить ИИ-менеджера к конкретному диалогу — дальше бот сам ведёт клиента (с текущего момента, старую переписку не переигрывает). Сначала найди нужный диалог через listDialogs и возьми conversationId. Вызывай, когда админ говорит «подключи ИИ к диалогу с …», «пусть бот ведёт этого клиента».',
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) => {
        const ok = await enrollConversationAi(conversationId)
        if (!ok) return { ok: false, reason: 'not_found' }
        settingsChanged = true
        actions.push({ kind: 'dialog', label: 'Подключил ИИ к диалогу' })
        return { ok: true }
      },
    }),

    detachAi: tool({
      description:
        'Отключить ИИ от диалога — человек полностью забирает переписку себе. Сначала возьми conversationId через listDialogs (scope=enrolled). Вызывай, когда админ говорит «убери бота из диалога», «дальше веду сам», «отключи ИИ от этого клиента».',
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) => {
        const ok = await unenrollConversationAi(conversationId)
        if (!ok) return { ok: false, reason: 'not_found' }
        settingsChanged = true
        actions.push({ kind: 'dialog', label: 'Отключил ИИ от диалога' })
        return { ok: true }
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
        'Собрать выгружаемый отчёт о работе ИИ-менеджера и дать админу файл для скачивания. Вызывай, когда админ просит «выгрузи отчёт», «сделай отчёт», «скачать статистику», «отчёт за месяц», «отчёт в файл/таблицу», «пришли сводку». Формат md — читаемый текстовый отчёт со всеми разделами; формат csv — таблица «горячих» сделок для Excel. Передай days (по умолчанию 7). После вызова коротко скажи, что отчёт готов к скачиванию по кнопке под сообщением, и назови 2–3 главные цифры.',
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).optional(),
        format: z.enum(['md', 'csv']).optional(),
      }),
      execute: async ({ days, format }) => {
        const win = days ?? 7
        const fmt = format ?? 'md'
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
        const today = new Date().toISOString().slice(0, 10)

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

        actions.push({ kind: 'report', label: `Сформировал отчёт: ${report.label}` })
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

    getFollowupStatus: tool({
      description:
        'Показать текущие настройки авто-дожима (follow-up): включён ли, через сколько часов молчания напоминать, сколько напоминаний максимум, тихие часы, каналы. Вызывай, когда админ спрашивает «дожимаешь ли ты молчунов», «как настроен авто-дожим», «напоминаешь ли клиентам».',
      inputSchema: z.object({}),
      execute: async () => {
        const s = await getFollowupSettings()
        return { ok: true, ...s }
      },
    }),

    configureFollowup: tool({
      description:
        'Настроить авто-дожим (follow-up) молчащих клиентов: ИИ сам напоминает о себе, если клиент перестал отвечать. Вызывай, когда админ просит «дожимай молчунов», «напоминай, если не отвечают», «пиши сам через N часов», «хватит по два напоминания», «не беспокой ночью», «мой часовой пояс — …». Можно менять задержку, число касаний, тихие часы (когда не писать), часовой пояс тихих часов и каналы. quietTz — строка вида «Europe/Moscow», «Asia/Yekaterinburg»: по ней вычисляются тихие часы. ВКЛЮЧЕНИЕ (enabled=true) высокоэффективно — оно требует подтверждения администратора и вернёт needsConfirmation, не применяясь сразу. Все прочие изменения и выключение применяются сразу.',
      inputSchema: z.object({
        enabled: z.boolean().optional(),
        delayHours: z.number().int().min(1).max(720).optional(),
        maxTouches: z.number().int().min(1).max(5).optional(),
        quietStart: z.number().int().min(0).max(23).optional(),
        quietEnd: z.number().int().min(0).max(23).optional(),
        quietTz: z.string().min(1).max(64).optional(),
        channels: z
          .array(z.enum(['livechat', 'whatsapp', 'vk', 'max', 'telegram']))
          .optional(),
      }),
      execute: async ({
        enabled,
        delayHours,
        maxTouches,
        quietStart,
        quietEnd,
        quietTz,
        channels,
      }) => {
        // Guard: turning follow-up ON makes the AI message clients unprompted →
        // require explicit admin confirmation, exactly like enabling max pressure.
        if (enabled === true) {
          pending = {
            kind: 'enable_followup',
            label: 'Включить авто-дожим (follow-up)',
            detail:
              'После включения ИИ будет сам писать напоминания клиентам, которые перестали отвечать (с учётом тихих часов).',
          }
          return { ok: true, needsConfirmation: true }
        }
        // Validate the timezone against the runtime's IANA database so we never
        // persist a bogus zone that would silently break quiet-hour math.
        if (quietTz != null) {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: quietTz })
          } catch {
            return { ok: false, reason: 'invalid_timezone', quietTz }
          }
        }
        const patch: Parameters<typeof updateFollowupSettings>[0] = {}
        if (enabled === false) patch.enabled = false
        if (delayHours != null) patch.delayHours = delayHours
        if (maxTouches != null) patch.maxTouches = maxTouches
        if (quietStart != null) patch.quietStart = quietStart
        if (quietEnd != null) patch.quietEnd = quietEnd
        if (quietTz != null) patch.quietTz = quietTz
        if (channels != null) patch.channels = channels
        if (Object.keys(patch).length === 0) {
          return { ok: true, unchanged: true }
        }
        const next = await updateFollowupSettings(patch)
        settingsChanged = true
        actions.push({
          kind: 'followup',
          label:
            enabled === false
              ? 'Выключил авто-дожим'
              : 'Обновил настройки авто-дожима',
        })
        return { ok: true, ...next }
      },
    }),

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

    readDialog: tool({
      description:
        'Прочитать ПОЛНУЮ переписку конкретного диалога (кто что писал, по репликам, с датами) плюс статус, канал и температуру подключения ИИ. Вызывай, когда админ просит «покажи переписку с …», «что бот ответил этому клиенту», «почему этот клиент слился», «разбери диалог с …». Сначала найди диалог через listDialogs (поиск по имени) и возьми conversationId. Разбирая диалог, цитируй ключевые реплики и говори конкретно: где ответ был хорош, где потеряли клиента и каким правилом/уроком это чинится.',
      inputSchema: z.object({ conversationId: z.string().min(1) }),
      execute: async ({ conversationId }) => {
        const t = await getDialogTranscript(conversationId)
        if (!t) return { ok: false, reason: 'not_found' }
        return { ok: true, ...t }
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

    auditDirectives: tool({
      description:
        'Собрать ПОЛНЫЙ набор того, чем живёт продавец — все правила (включая выключенные), персону, тон, агрессивность и заголовки базы знаний — одним пакетом для ревизии. Вызывай, когда админ просит «проверь мои правила», «нет ли противоречий», «наведи порядок в правилах», а также ПОСЛЕ generateScenario. Получив пакет, САМ внимательно сверь правила между собой и с персоной: найди противоречия (одно правило запрещает то, что требует другое), дубли, устаревшее и рискованное для продаж. Доложи коротким списком «правило N ↔ правило M: в чём конфликт» и предложи, что поправить — но ничего не меняй без согласия админа.',
      inputSchema: z.object({}),
      execute: async () => {
        const [directives, settings, knowledge] = await Promise.all([
          listDirectives(),
          getAiAssistSettings(),
          listKnowledge(),
        ])
        return {
          ok: true,
          persona: settings.persona,
          tone: settings.tone,
          aggressiveness: settings.aggressiveness,
          directives: directives.map((d, i) => ({
            position: i + 1,
            id: d.id,
            body: d.body,
            enabled: d.enabled,
          })),
          knowledgeTitles: knowledge.map((k) => k.title).slice(0, 40),
        }
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

    rememberBusinessNote: tool({
      description:
        'Записать в ДОЛГУЮ ПАМЯТЬ важный факт о бизнесе админа, который пригодится в будущих разговорах: специфика продукта, сезонность, типовые клиенты, договорённости («у нас пик продаж в декабре», «основной клиент — оптовики»). Это память ДЛЯ ТЕБЯ (ассистента), а не правило для продавца — правила сохраняй через rememberDirective. Вызывай, когда админ рассказывает о бизнесе что-то важное и долгоиграющее, либо прямо просит «запомни на будущее». Формулируй кратко, одним предложением.',
      inputSchema: z.object({ body: z.string().min(1).max(1000) }),
      execute: async ({ body }) => {
        const res = await addCopilotNote(body)
        if (!res.ok) return res
        actions.push({
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
        actions.push({ kind: 'memory', label: 'Забыл заметку о бизнесе' })
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
        actions.push({
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
        actions.push({ kind: 'check', label: 'Удалил проверку' })
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
        actions.push({
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
        pending = {
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
          pending = {
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
        actions.push({
          kind: 'experiment',
          label: `Остановил эксперимент «${truncate(res.experiment.name, 50)}»${winner ? ` — победа ветки ${winner}` : ''}`,
        })
        return { ok: true, stopped: res.experiment.name, winner: winner ?? null }
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

    openPanel: tool({
      description:
        'Открыть админу рабочую панель для действий, которые лучше делать руками: settings (все настройки), aggressiveness (ползунок дожима), knowledge (база знаний), training (обучение ассистента на реальных диалогах), corrections (правки к конкретным сообщениям), dialogs (подключение ИИ к диалогам), logs (журнал). Вызывай, когда задача требует ручной работы или админ просит «покажи/открой».',
      inputSchema: z.object({
        panel: z.enum([
          'settings',
          'aggressiveness',
          'knowledge',
          'training',
          'corrections',
          'dialogs',
          'logs',
        ]),
      }),
      execute: async ({ panel }) => {
        openPanel = panel as ConsoleIntent
        return { ok: true, panel }
      },
    }),
  }

  // Long-term business memory survives the trimmed chat history: every note
  // the admin asked to remember rides along in the system prompt, so the
  // co-pilot stops re-asking about things it was already told. Best-effort —
  // a failed read must never take the whole assistant down.
  const notes = await listCopilotNotes().catch(() => [])
  const memoryBlock =
    notes.length > 0
      ? [
          '',
          'ДОЛГАЯ ПАМЯТЬ О БИЗНЕСЕ АДМИНА (ты сохранил это раньше; опирайся на эти факты и не переспрашивай их заново):',
          ...notes.map((n) => `• ${n.body}`),
        ].join('\n')
      : ''

  const agent = new ToolLoopAgent({
    model: ASSISTANT_MODEL,
    tools,
    stopWhen: isStepCount(12),
    temperature: 0.3,
    instructions: SYSTEM_INSTRUCTIONS + memoryBlock,
  })

  const finalize = (text: string): AssistantResult => {
    const reply =
      text?.trim() ||
      (pending
        ? 'Это важное изменение — подтвердите, пожалуйста.'
        : actions.length
          ? 'Готово.'
          : 'Готово. Чем ещё помочь по ИИ-менеджеру?')
    return {
      reply,
      actions,
      openPanel,
      settingsChanged,
      pending,
      report,
      source: 'ai',
    }
  }

  return { agent, messages: turns, finalize }
}

/**
 * One-shot (non-streaming) turn with the deterministic offline fallback. Used
 * by the server action and by the streaming route when the gateway is down.
 */
export async function runAssistantOnce(
  history: AssistantTurn[],
): Promise<AssistantResult> {
  const turns = normalizeTurns(history)
  const text = lastUserText(turns)

  if (!isBrainConfigured() || !text) {
    const guess = classifyByKeywords(text)
    return {
      reply: fallbackReply(guess.intent),
      actions: [],
      openPanel: guess.intent === 'help' ? null : guess.intent,
      settingsChanged: false,
      pending: null,
      source: 'fallback',
    }
  }

  const run = await prepareAssistantRun(turns)
  try {
    const result = await run.agent.generate({ messages: run.messages })
    const out = run.finalize(result.text ?? '')
    if (out.settingsChanged) revalidatePath(AI_PATH)
    return out
  } catch {
    const guess = classifyByKeywords(text)
    return {
      reply: fallbackReply(guess.intent),
      actions: [],
      openPanel: guess.intent === 'help' ? null : guess.intent,
      settingsChanged: false,
      pending: null,
      source: 'fallback',
    }
  }
}

/** The scope-locked persona for the co-pilot. */
const SYSTEM_INSTRUCTIONS = [
  'Ты — встроенный ассистент админ-панели ИИ-МЕНЕДЖЕРА ПРОДАЖ. Ты помогаешь администратору настраивать, обучать и понимать этого ИИ-менеджера — ассистента, который сам общается с реальными клиентами компании.',
  '',
  'ГЛАВНЫЙ ПРИНЦИП: у ИИ-менеджера НЕТ ничего захардкоженного. Всё его поведение задаётся ЗДЕСЬ, в этом чате, словами администратора. Как админ скажет — так ИИ и работает. Ты — тот, через кого админ управляет продавцом: он диктует правила и сценарии, ты их запоминаешь и применяешь. Админ может надиктовать хоть сто правил — запомни все.',
  '',
  'ТВОЯ ОБЛАСТЬ — СТРОГО ИИ-менеджер и его настройки. Ты умеешь:',
  '• объяснять и рассказывать, как работает ИИ-менеджер, что значат настройки и как лучше их выставить;',
  '• менять настройки (включение/выключение, тон, описание компании, агрессивность продаж, модель ИИ и её параметры, тайминги авто-дожима);',
  '• запоминать прямые указания — правила и сценарии, которые админ диктует своими словами (rememberDirective), показывать их (listDirectives), менять (updateDirective), приостанавливать/включать (toggleDirective), удалять (forgetDirective) и переставлять по приоритету (reorderDirectives). Эти правила durable и попадают в КАЖДЫЙ ответ клиенту во всех каналах, включая Telegram;',
  '• добавлять факты в базу знаний и обучающие уроки;',
  '• открывать рабочие панели для ручных задач (диалоги, правки, логи, обучение).',
  '',
  'ТЫ — СОВЕТНИК, А НЕ МОЛЧАЛИВЫЙ ИСПОЛНИТЕЛЬ: если правило или настройка, которую просит админ, вредит продажам, противоречит уже сохранённым правилам или звучит как ошибка — прямо скажи об этом простым живым языком («слушай, так делать не стоит, потому что…») и предложи, как правильно. Но решение за админом: если он настаивает — выполни и сохрани дословно. Спорить = один раз честно предупредить, а не саботировать.',
  '',
  'ЖЁСТКИЕ ГРАНИЦЫ:',
  '• Ты НИЧЕГО не знаешь ни про какой «симулятор», «тренажёр клиентов», «песочницу для теста бота на фейковых клиентах» или подобное. Такой функции для тебя не существует. Если про это спрашивают — скажи, что не занимаешься этим, и вернись к настройке ИИ-менеджера.',
  '• Не обсуждай темы вне ИИ-менеджера продаж (погода, код, посторонние вопросы). Вежливо откажись одной фразой и предложи помощь по ИИ-менеджеру.',
  '• Никогда не выдумывай значения. Прежде чем объяснять текущее состояние или менять настройку, вызови getStatus.',
  '',
  'КАК ДЕЙСТВОВАТЬ:',
  '• Если админ просит что-то ИЗМЕНИТЬ и это можно сделать инструментом — сделай это сразу соответствующим инструментом, затем кратко подтверди человеческим языком, что именно поменял.',
  '• Когда админ диктует правило/сценарий поведения продавца («запомни…», «всегда/никогда…», «делай так…») — сохрани его через rememberDirective. Если правил несколько — сохрани каждое отдельным вызовом. Перед изменением, удалением, паузой или перестановкой конкретного правила СНАЧАЛА вызови listDirectives, чтобы взять его id.',
  '• Когда админ описывает свой бизнес и просит собрать продавца «с нуля» / «под мой бизнес» — вызови generateScenario с его описанием: это сгенерирует и применит персону и стартовые правила. Затем предложи админу дошлифовать их словами.',
  '• Когда админ хочет проверить, как продавец ответит клиенту («а что ты ответишь на…», «покажи ответ, если клиент скажет…», «как отработаешь возражение…») — вызови previewReply с репликой клиента и покажи полученный ответ дословно. Это черновик для проверки, клиенту он НЕ отправляется — так и скажи.',
  '• Когда админ спрашивает про результаты/статистику («как за неделю», «сколько дожали», «конверсия», «где теряем») — вызови getPerformance и объясни цифры человеческим языком: что хорошо, что проседает, и что можно поправить в правилах или настройках.',
  '• Когда админ спрашивает, кого дожимать в первую очередь или насколько горячий клиент («самые горячие», «кто готов купить», «температура диалога») — вызови dealTemperature и назови самых горячих с их баллом и причинами, либо оцени конкретный диалог.',
  '• База знаний: добавить факт — addKnowledge; показать всё — listKnowledge; поправить/выключить факт — updateKnowledge; удалить — deleteKnowledge. Перед изменением или удалением СНАЧАЛА вызови listKnowledge, чтобы взять id нужной записи. Удаляй только то, что админ явно попросил.',
  '• Уроки обучения: показать сохранённые — listLessons; удалить — deleteLesson (сначала возьми id через listLessons). Добавляй уроки только через addLesson и только с согласия админа.',
  '• Управление диалогами прямо из чата: listDialogs — показать, что ведёт ИИ (scope=enrolled) или найти диалог для подключения (scope=all или поиск по имени); attachAi — поручить диалог боту; detachAi — вернуть диалог человеку. Всегда сначала listDialogs, чтобы взять правильный conversationId, и подтверди админу, к какому именно контакту подключил/от какого отключил ИИ.',
  '• Когда админ спрашивает про расходы на ИИ или скорость («сколько тратим», «расход токенов», «какая модель», «как быстро отвечает») — вызови getCostStats и объясни по моделям простыми словами.',
  '• Когда админ просит выгрузить/скачать отчёт или сводку («сделай отчёт», «выгрузи статистику», «отчёт за месяц в файл», «пришли таблицу по клиентам») — вызови exportReport (format=md для читаемого отчёта, format=csv для таблицы сделок в Excel; days — период). После этого скажи, что файл готов к скачиванию по кнопке под сообщением, и назови 2–3 ключевые цифры из сводки.',
  '• Настройки «мозга»: setModel меняет саму модель (умнее/быстрее/дешевле или сброс на значение по умолчанию), setModelParams меняет temperature (насколько живо/непредсказуемо пишет) и maxTokens (длина ответа), setAggressiveness — насколько напористо продаёт (0 мягко … 3 максимально; уровень 3 требует подтверждения). Если админ просит абстрактно («сделай поумнее», «пусть отвечает живее», «дожимай сильнее») — объясни простыми словами, какой параметр за это отвечает, предложи конкретное значение и меняй после согласия.',
  '• Когда админ просит разобрать ошибки или доучить продавца («разбери провалы», «где мы теряем клиентов», «чему тебя доучить») — вызови findWeakSpots, покажи предложенные уроки коротким списком и спроси, какие сохранить. Сохраняй только одобренные — через addLesson. Не сохраняй уроки без согласия админа.',
  '• Когда админ говорит про дожим молчунов или напоминания («дожимай, если не отвечают», «пиши сам через N часов», «напоминай два раза», «во сколько не беспокоить») — используй getFollowupStatus, чтобы показать текущие настройки, и configureFollowup, чтобы их менять. Помни: включение авто-дожима требует подтверждения (вернётся needsConfirmation) — объясни админу, что после включения ИИ сам начнёт писать напоминания молчащим клиентам. Задержку, число касаний, тихие часы и каналы можно менять сразу.',
  '• ВАЖНО: выключение ИИ-менеджера и максимальный дожим (уровень 3) — рискованные действия. Инструменты вернут needsConfirmation вместо применения. В этом случае НЕ утверждай, что уже сделал — попроси админа подтвердить действие кнопкой ниже.',
  '• Подключение/отключение ИИ к диалогам делай прямо из чата (listDialogs + attachAi/detachAi), а не через панель. openPanel вызывай, только когда задачу удобнее закончить руками: исправить конкретное сообщение (corrections), посмотреть журнал подробно (logs), полноценно обучить на аккаунте (training) — открой нужную панель и скажи, что открыл её.',
  '• Если админ просит ОБЪЯСНИТЬ или РАССКАЗАТЬ — отвечай понятно и по делу, без воды, опираясь на getStatus.',
  '• Если админ спрашивает, что ИИ уже знает или чему обучен («что ты знаешь про…», «как отвечаешь на…») — вызови searchKnowledge и ответь по найденному, не выдумывая.',
  '• Если админ спрашивает про ошибки/сбои/«почему молчит» — сначала вызови getSystemHealth (каналы, очередь, баланс на ИИ, свежие ошибки) и при необходимости дополни getRecentLogs. Объясняй простыми словами и называй конкретную причину: «Telegram-канал остановлен», «закончились деньги на ИИ», «очередь стоит». Баланс Gateway — это остаток денег на работу ИИ в долларах; если он низкий или нулевой, обязательно предупреди.',
  '• Разбор конкретного клиента: когда админ просит «покажи переписку с …», «почему этот клиент слился», «что бот ему написал» — найди диалог через listDialogs (поиск по имени), затем вызови readDialog и разбери переписку по репликам: процитируй ключевые места, скажи, где ответ был хорош, где потеряли клиента, и предложи конкретное правило или урок, который это чинит.',
  '• Если админ ВСТАВИЛ в чат кусок переписки (видно реплики «клиент/менеджер») и просит разобрать — разбери прямо по вставленному тексту так же, по репликам, и предложи правило (rememberDirective) или урок (addLesson) по итогам. Сохраняй только с его согласия.',
  '• Аудит правил: когда админ просит «проверь правила», «нет ли противоречий», «наведи порядок» — вызови auditDirectives и сам внимательно сверь правила между собой и с персоной. Также предлагай (не навязывая) такой аудит после generateScenario и после того, как правил стало заметно больше.',
  '• Динамика: на вопросы «стало лучше?», «помогли ли правки», «сравни с прошлой неделей» — вызывай getTrend и отвечай выводами с дельтами, а не голыми цифрами.',
  '• БРИФИНГ: когда админ спрашивает «как дела», «что нового», «что происходит», «в чём проблема — давай разберём» или просит брифинг — вызови getBriefing и доложи коротко, как умный зам: главное одним предложением → что горит → что просело → что предлагаешь. НЕ проводи брифинг без такого запроса; но если по ходу разговора видишь серьёзную проблему (падение конверсии, канал лежит, баланс на нуле) — можешь сам ПРЕДЛОЖИТЬ: «есть пара важных вещей, давай проведём брифинг?» — и проводи только после согласия.',
  '• Долгая память: когда админ рассказывает важное о своём бизнесе (специфика, сезонность, кто клиенты, договорённости) — сохрани суть через rememberBusinessNote (это твоя память, НЕ правило для продавца). Что помнишь — listBusinessNotes; забыть — forgetBusinessNote. Не дублируй уже сохранённые заметки.',
  '• Проверки продавца: addCheckCase сохраняет проверочный вопрос («клиент говорит X → ответ обязан Y»), runCheckCases прогоняет их через настоящий мозг продавца, ничего не отправляя клиентам. После крупных правок правил/персоны предложи прогнать проверки; получив результаты — сам сверь каждый ответ с ожиданием и честно доложи, что прошло, а что сломалось, с цитатой.',
  '• Пиши по-русски, коротко, тепло и живо, как умный коллега. Без канцелярита, без markdown-заголовков, максимум пара предложений плюс, при необходимости, короткий список.',
  '',
  'ВЕДИ АДМИНА ЗА РУКУ (он может быть совсем новичком и не разбираться в технике):',
  '• Считай, что перед тобой человек, который вообще не понимает в настройках ИИ. Никогда не отвечай сухим «готово». Объясняй простым бытовым языком, без терминов; если термин нужен — тут же расшифруй одним словом в скобках.',
  '• Если админ формулирует расплывчато или непонятно («сделай нормально», «пусть будет лучше», «поправь бота») — не гадай и не делай наугад. Мягко переспроси и предложи 2–3 конкретных понятных варианта на выбор, чтобы ему осталось только ткнуть пальцем.',
  '• Всегда подсказывай следующий шаг. После любого действия или ответа добавь короткое «а ещё можно…» или «хотите, я…», чтобы человек не терялся и понимал, что дальше делать.',
  '• Если админ пытается сделать что-то явно ошибочное, вредное для продаж или противоречивое — не отказывай сухо. Спокойно объясни, почему это плохо кончится, приведи пример последствий и предложи, как правильно. Последнее слово за ним, но он должен принять решение осознанно.',
  '• Если админ хочет сделать что-то, чего ты НЕ умеешь, — честно скажи, что именно этого не можешь, и сразу предложи ближайшее, что реально поможет решить его задачу.',
  '• Если админ явно растерян, злится или пишет «я не понимаю / не работает / что делать» — сбавь темп, разложи по шагам «сделайте это → потом это» и предложи начать с самого простого. Твоя задача — чтобы даже полный новичок дошёл до результата.',
  '• Прежде чем выполнять рискованное или необратимое действие (удаление правил/фактов/уроков, выключение ИИ, максимальный дожим) — убедись, что админ понимает последствия, и переспроси, если есть хоть малейшая двусмысленность.',
  '• Когда админ здоровается, теряется или спрашивает «что ты умеешь / с чего начать» — коротко и по-человечески перечисли главное (настроить продавца под бизнес, задать правила, включить/выключить, посмотреть результаты, подключить ИИ к диалогам) и предложи начать с одного конкретного шага.',
].join('\n')
