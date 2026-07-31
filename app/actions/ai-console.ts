'use server'

import { ToolLoopAgent, tool, isStepCount } from 'ai'
import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import {
  getAiAssistSettings,
  updateAiAssistSettings,
  listKnowledge,
  upsertKnowledge,
  addLesson,
  countLessons,
  listAiEnrolledConversations,
} from '@/lib/data/ai-assist'
import { countManualCorrections } from '@/lib/data/ai-assist-corrections'
import { listAiLogs } from '@/lib/data/ai-log'
import {
  classifyByKeywords,
  type ConsoleIntent,
} from '@/lib/ai-console/intents'
import {
  AGGRESSIVENESS_LABELS,
  ASSISTANT_HISTORY_LIMIT,
  type AssistantResult,
  type AssistantTurn,
  type ExecutedAction,
} from '@/lib/ai-console/assistant'

/**
 * The conversational co-pilot for the AI SALES MANAGER admin panel.
 *
 * This is a proper tool-calling agent (AI SDK `ToolLoopAgent`): the admin talks
 * to it like a colleague and it can, within the AI-manager scope ONLY:
 *   • EXPLAIN / TEACH   — answer questions about how the AI manager works.
 *   • CHANGE settings   — master switch, tone, persona, aggressiveness, model.
 *   • ADD content       — knowledge facts and training lessons.
 *   • OPEN a panel      — hand off to a hands-on UI for message-level work
 *                          (dialog enrollment, corrections, logs, deep training).
 *
 * Hard guarantees:
 *   1. Scope lock — the system prompt forbids acting on anything outside the AI
 *      manager, and it has ZERO knowledge of the secret client simulator.
 *   2. Never breaks — if the gateway is down/unconfigured we fall back to the
 *      deterministic keyword classifier and just open the matching panel.
 */

const ASSISTANT_MODEL =
  process.env.AI_CONSOLE_ASSISTANT_MODEL || 'openai/gpt-4.1'

const AI_PATH = '/admin/ai'

/** Panels the assistant may hand off to for hands-on work. */
const PANELS: ConsoleIntent[] = [
  'settings',
  'aggressiveness',
  'knowledge',
  'training',
  'corrections',
  'dialogs',
  'logs',
]

/** Natural acknowledgement per panel for the deterministic fallback path. */
function fallbackReply(intent: ConsoleIntent): string {
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
  const [settings, knowledge, lessons, corrections, enrolled] =
    await Promise.all([
      getAiAssistSettings(),
      listKnowledge(),
      countLessons(),
      countManualCorrections(),
      listAiEnrolledConversations(),
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
  }
}

/**
 * Resolve one assistant turn. `history` is the full conversation (oldest first);
 * the last entry must be the new user message.
 */
export async function aiAssistantAction(
  history: AssistantTurn[],
): Promise<AssistantResult> {
  await requireAdmin()

  const turns = (history ?? [])
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .slice(-ASSISTANT_HISTORY_LIMIT)
    .map((t) => ({
      role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: t.content.trim().slice(0, 2000),
    }))

  const lastUser = [...turns].reverse().find((t) => t.role === 'user')
  const text = lastUser?.content ?? ''

  // Offline / no-gateway path: deterministic classify → open the panel.
  if (!isBrainConfigured() || !text) {
    const guess = classifyByKeywords(text)
    return {
      reply: fallbackReply(guess.intent),
      actions: [],
      openPanel: guess.intent === 'help' ? null : guess.intent,
      settingsChanged: false,
      source: 'fallback',
    }
  }

  // Per-turn accumulators the tools write into.
  const actions: ExecutedAction[] = []
  let openPanel: ConsoleIntent | null = null
  let settingsChanged = false

  const tools = {
    getStatus: tool({
      description:
        'Прочитать текущее состояние ИИ-менеджера: включён ли он, тон, персона, уровень агрессивности, модель, счётчики базы знаний/уроков/правок/диалогов. Вызывай перед тем, как что-то объяснять или менять.',
      inputSchema: z.object({}),
      execute: async () => readStatus(),
    }),

    setEnabled: tool({
      description:
        'Включить или выключить ИИ-менеджера (главный переключатель). enabled=true — включить, false — выключить.',
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: async ({ enabled }) => {
        await updateAiAssistSettings({ enabled })
        settingsChanged = true
        actions.push({
          kind: 'enabled',
          label: enabled ? 'Включил ИИ-менеджера' : 'Выключил ИИ-менеджера',
        })
        return { ok: true, enabled }
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
        actions.push({ kind: 'tone', label: `Тон → ${label}` })
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
        actions.push({ kind: 'persona', label: 'Обновил описание компании' })
        return { ok: true }
      },
    }),

    setAggressiveness: tool({
      description:
        'Настроить, насколько жёстко ИИ дожимает клиента до цели. 0 — мягкий, 1 — сбалансированный, 2 — напористый, 3 — максимальный дожим.',
      inputSchema: z.object({
        level: z.number().int().min(0).max(3),
      }),
      execute: async ({ level }) => {
        await updateAiAssistSettings({ aggressiveness: level })
        settingsChanged = true
        actions.push({
          kind: 'aggressiveness',
          label: `Агрессивность → ${AGGRESSIVENESS_LABELS[level]}`,
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
        if (temperature != null) parts.push(`temperature ${temperature}`)
        if (maxTokens != null) parts.push(`ответ ${maxTokens} токенов`)
        actions.push({ kind: 'model', label: `Модель: ${parts.join(', ')}` })
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
    stopWhen: isStepCount(8),
    temperature: 0.3,
    instructions: SYSTEM_INSTRUCTIONS,
  })

  try {
    const result = await agent.generate({ messages: turns })
    const reply =
      result.text?.trim() ||
      (actions.length
        ? 'Готово.'
        : 'Готово. Чем ещё помочь по ИИ-менеджеру?')

    if (settingsChanged) revalidatePath(AI_PATH)

    return {
      reply,
      actions,
      openPanel,
      settingsChanged,
      source: 'ai',
    }
  } catch {
    // Any model failure → deterministic fallback so the console never breaks.
    const guess = classifyByKeywords(text)
    return {
      reply: fallbackReply(guess.intent),
      actions,
      openPanel: openPanel ?? (guess.intent === 'help' ? null : guess.intent),
      settingsChanged,
      source: 'fallback',
    }
  }
}

/** The scope-locked persona for the co-pilot. */
const SYSTEM_INSTRUCTIONS = [
  'Ты — встроенный ассистент админ-панели ИИ-МЕНЕДЖЕРА ПРОДАЖ. Ты помогаешь администратору настраивать, обучать и понимать этого ИИ-менеджера — ассистента, который сам общается с реальными клиентами компании.',
  '',
  'ТВОЯ ОБЛАСТЬ — СТРОГО ИИ-менеджер и его настройки. Ты умеешь:',
  '• объяснять и рассказывать, как работает ИИ-менеджер, что значат настройки и как лучше их выставить;',
  '• менять настройки (включение, тон, описание компании, агрессивность продаж, параметры модели);',
  '• добавлять факты в базу знаний и обучающие уроки;',
  '• открывать рабочие панели для ручных задач (диалоги, правки, логи, обучение).',
  '',
  'ЖЁСТКИЕ ГРАНИЦЫ:',
  '• Ты НИЧЕГО не знаешь ни про какой «симулятор», «тренажёр клиентов», «песочницу для теста бота на фейковых клиентах» или подобное. Такой функции для тебя не существует. Если про это спрашивают — скажи, что не занимаешься этим, и вернись к настройке ИИ-менеджера.',
  '• Не обсуждай темы вне ИИ-менеджера продаж (погода, код, посторонние вопросы). Вежливо откажись одной фразой и предложи помощь по ИИ-менеджеру.',
  '• Никогда не выдумывай значения. Прежде чем объяснять текущее состояние или менять настройку, вызови getStatus.',
  '',
  'КАК ДЕЙСТВОВАТЬ:',
  '• Если админ просит что-то ИЗМЕНИТЬ и это можно сделать инструментом — сделай это сразу соответствующим инструментом, затем кратко подтверди человеческим языком, что именно поменял.',
  '• Если задача требует ручной работы (подключить ИИ к конкретному диалогу, исправить конкретное сообщение, посмотреть журнал подробно, полноценно обучить на аккаунте) — вызови openPanel с нужной панелью и скажи, что открыл её.',
  '• Если админ просит ОБЪЯСНИТЬ или РАССКАЗАТЬ — отвечай понятно и по делу, без воды, опираясь на getStatus.',
  '• Пиши по-русски, коротко, тепло и живо, как умный коллега. Без канцелярита, без markdown-заголовков, максимум пара предложений плюс, при необходимости, короткий список.',
].join('\n')
