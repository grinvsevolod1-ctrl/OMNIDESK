import 'server-only'
import { ToolLoopAgent, tool, isStepCount } from 'ai'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import {
  generateManagerReply,
  generateSalesScenario,
  isBrainConfigured,
} from '@/lib/ai/manager-brain'
import {
  getAiAssistSettings,
  updateAiAssistSettings,
  listKnowledge,
  upsertKnowledge,
  addLesson,
  listBrainLessons,
  listLessons,
  countLessons,
  listAiEnrolledConversations,
  retrieveKnowledge,
} from '@/lib/data/ai-assist'
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
        const facts = knowledge
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

    openPanel: tool({
      description:
        'Открыть админу рабочую панель для действий, которые лучше делать руками: settings (все настройки), aggressiveness (ползунок дожима), knowledge (база знаний), training (обучение и песочница), corrections (правки к конкретным сообщениям), dialogs (подключение ИИ к диалогам), logs (журнал). Вызывай, когда задача требует ручной работы или админ просит «покажи/открой».',
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

  const agent = new ToolLoopAgent({
    model: ASSISTANT_MODEL,
    tools,
    stopWhen: isStepCount(12),
    temperature: 0.3,
    instructions: SYSTEM_INSTRUCTIONS,
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
  '• менять настройки (включение, тон, описание компании, агрессивность продаж, параметры модели);',
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
  '• ВАЖНО: выключение ИИ-менеджера и максимальный дожим (уровень 3) — рискованные действия. Инструменты вернут needsConfirmation вместо применения. В этом случае НЕ утверждай, что уже сделал — попроси админа подтвердить действие кнопкой ниже.',
  '• Если задача требует ручной работы (подключить ИИ к конкретному диалогу, исправить конкретное сообщение, посмотреть журнал подробно, полноценно обучить на аккаунте) — вызови openPanel с нужной панелью и скажи, что открыл её.',
  '• Если админ просит ОБЪЯСНИТЬ или РАССКАЗАТЬ — отвечай понятно и по делу, без воды, опираясь на getStatus.',
  '• Если админ спрашивает, что ИИ уже знает или чему обучен («что ты знаешь про…», «как отвечаешь на…») — вызови searchKnowledge и ответь по найденному, не выдумывая.',
  '• Если админ спрашивает про ошибки/сбои/«почему молчит» — вызови getRecentLogs и объясни простыми словами, что нашёл.',
  '• Пиши по-русски, коротко, тепло и живо, как умный коллега. Без канцелярита, без markdown-заголовков, максимум пара предложений плюс, при необходимости, короткий список.',
].join('\n')
