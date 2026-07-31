'use server'

import { generateObject } from 'ai'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import {
  classifyByKeywords,
  INTENT_CATALOGUE,
  type ConsoleIntent,
  type RouteResult,
} from '@/lib/ai-console/intents'

/**
 * Router for the admin AI console. Turns a free-text admin command into one of
 * the fixed console intents (see lib/ai-console/intents.ts), so the UI can open
 * the matching panel inline — no tabs, just "type what you want".
 *
 * Two-tier strategy for robustness:
 *   1. A deterministic keyword classifier always runs first — instant, free, and
 *      works with no gateway. It is the guaranteed fallback.
 *   2. When the gateway is configured we ask a small, fast model to classify via
 *      structured output (generateObject + zod enum), seeded with the keyword
 *      guess. The LLM handles paraphrases/typos the keywords miss and writes a
 *      short natural acknowledgement. ANY LLM failure silently falls back to the
 *      keyword result, so the console never breaks.
 */

// Small, cheap, fast model for classification — this is a routing decision, not
// customer-facing prose, so we optimise for latency/cost over eloquence.
const ROUTER_MODEL = process.env.AI_CONSOLE_ROUTER_MODEL || 'openai/gpt-4.1-mini'

const INTENT_IDS = INTENT_CATALOGUE.map((m) => m.intent) as [
  ConsoleIntent,
  ...ConsoleIntent[],
]
const ALL_INTENTS: ConsoleIntent[] = [...INTENT_IDS, 'help']

/** Zod schema for the structured classification result. */
const routeSchema = z.object({
  intent: z.enum([...INTENT_IDS, 'help'] as [ConsoleIntent, ...ConsoleIntent[]]),
  reply: z
    .string()
    .describe('Короткое дружелюбное подтверждение на русском, 1 предложение.'),
  confidence: z.number().min(0).max(1),
})

/** Build the catalogue description injected into the classifier prompt. */
function catalogueForPrompt(): string {
  const lines = INTENT_CATALOGUE.map(
    (m) =>
      `- ${m.intent}: ${m.label} — ${m.description}. Примеры: ${m.examples
        .slice(0, 3)
        .join('; ')}.`,
  )
  lines.push(
    '- help: намерение неясно или не относится ни к одному пункту — покажи подсказки.',
  )
  return lines.join('\n')
}

/** Human, non-robotic default acknowledgement per intent (fallback path). */
function defaultReply(intent: ConsoleIntent): string {
  switch (intent) {
    case 'settings':
      return 'Открываю настройки ИИ.'
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
      return 'Не совсем понял запрос — вот, что я умею.'
  }
}

/**
 * Resolve an admin command to a console intent. Always returns a usable result.
 */
export async function aiCommandRouterAction(
  rawText: string,
): Promise<RouteResult> {
  await requireAdmin()

  const text = (rawText ?? '').trim().slice(0, 500)
  const fallback = classifyByKeywords(text)

  // Empty input → straight to help, no model call.
  if (!text) {
    return {
      intent: 'help',
      reply: defaultReply('help'),
      confidence: 0,
      source: 'fallback',
    }
  }

  // No gateway → deterministic result only.
  if (!isBrainConfigured()) {
    return {
      intent: fallback.intent,
      reply: defaultReply(fallback.intent),
      confidence: fallback.confidence,
      source: 'fallback',
    }
  }

  try {
    const { object } = await generateObject({
      model: ROUTER_MODEL,
      schema: routeSchema,
      temperature: 0,
      system: [
        'Ты — маршрутизатор админ-панели ИИ-менеджера продаж.',
        'Определи, какой раздел хочет открыть администратор по его сообщению, и выбери РОВНО одно намерение из списка.',
        'Отвечай строго в заданной структуре. Поле reply — короткое человеческое подтверждение на русском, без канцелярита и без markdown.',
        'Если сообщение не относится ни к одному разделу или слишком расплывчато — верни intent "help".',
        '',
        'Доступные намерения:',
        catalogueForPrompt(),
        '',
        `Подсказка от офлайн-классификатора (можешь учесть, но реши сам): "${fallback.intent}".`,
      ].join('\n'),
      prompt: `Сообщение администратора: "${text}"`,
    })

    const intent = ALL_INTENTS.includes(object.intent) ? object.intent : 'help'
    const reply = object.reply?.trim() || defaultReply(intent)
    // Guard against a model returning an absurd confidence.
    const confidence = Math.max(0, Math.min(1, Number(object.confidence) || 0))
    return { intent, reply, confidence, source: 'ai' }
  } catch {
    // Any gateway/parse failure → deterministic fallback, never throw at the UI.
    return {
      intent: fallback.intent,
      reply: defaultReply(fallback.intent),
      confidence: fallback.confidence,
      source: 'fallback',
    }
  }
}
