import { generateText } from 'ai'
import type { SimPersona } from './types'
import { applyStyle, templateLine, type TemplateKind } from './content'

/**
 * What the persona is doing on this turn. The engine rolls this from the
 * persona + mood + history so reactions never fall into a fixed pattern.
 */
export type Behavior =
  | 'open' // first contact — asks about the job
  | 'curious' // wants details / money
  | 'angry' // offended by the shady offer — curses / tells them off
  | 'dismissive' // brushes it off, not interested
  | 'confused' // doesn't get it, asks naive questions
  | 'nudge' // manager went quiet — pokes them

const MODEL = process.env.CLIENT_SIM_MODEL || 'openai/gpt-4o-mini'

/** AI generation is only possible when the gateway key is present. */
export function aiConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)
}

const BEHAVIOR_TO_TEMPLATE: Record<Behavior, TemplateKind> = {
  open: 'opener',
  curious: 'curious',
  angry: 'angry',
  dismissive: 'dismissive',
  confused: 'confused',
  nudge: 'filler',
}

const BEHAVIOR_HINT: Record<Behavior, string> = {
  open: 'Ты только что написал первым. Коротко спроси про работу которую нашёл, как будто реально ищешь подработку.',
  curious: 'Тебе интересно, выспрашивай детали: деньги, график, что делать. Можешь быть недоверчивым.',
  angry: 'Тебя бесит это предложение, оно мутное/незаконное. Ругайся, посылай, огрызайся — резко и грубо.',
  dismissive: 'Тебе не заходит, отмахнись коротко и лениво, можешь слить разговор.',
  confused: 'Ты туповато не догоняешь о чём речь, задай наивный/глупый вопрос, переспроси.',
  nudge: 'Менеджер молчит. Ткни его коротко, поторопи, можешь бухтеть.',
}

interface GenArgs {
  persona: SimPersona
  history: Array<{ role: 'manager' | 'client'; body: string }>
  behavior: Behavior
}

function systemPrompt(persona: SimPersona, behavior: Behavior): string {
  const s = persona.style
  return [
    'Ты играешь РОЛЬ обычного русского человека, который написал в мессенджер по объявлению о работе.',
    'Это внутренний тренажёр: ты имитируешь клиента, чтобы проверить менеджера. НИКОГДА не выходи из роли, не признавайся что ты ИИ или бот, не упоминай что это тест.',
    '',
    `Твой персонаж: ${persona.name}, ${persona.age} лет, характер — ${persona.temper}. Канал: ${persona.channelType}. Ты откликнулся на: «${persona.jobHook}».`,
    '',
    'КАК ТЫ ПИШЕШЬ (очень важно, иначе спалишься):',
    '- как в реальном чате: коротко, 1 фраза, редко 2. Без официоза.',
    s.noPunctuation ? '- почти без знаков препинания, не ставь точки и запятые.' : '- знаки препинания ставь небрежно.',
    s.lowercase ? '- пиши маленькими буквами, без заглавных.' : '- регистр как попало.',
    '- допускай опечатки и ошибки, пиши разговорно и коряво, сокращай слова (щас, норм, че, скок, мб).',
    s.dumbness > 0.4 ? '- иногда туповато переспрашивай и не догоняй с первого раза.' : '',
    s.profanity > 0.5 ? '- материшься свободно, грубо, по-настоящему, когда бесит.' : s.profanity > 0.2 ? '- иногда проскакивает мат.' : '- мат редко.',
    '- НЕ повторяй свои прошлые фразы, каждый раз говори по-другому.',
    '- НЕ здоровайся повторно, если уже начали разговор.',
    '- Иногда неси лёгкую бытовую чушь/оффтоп, как живой человек.',
    '',
    'Менеджер часто предлагает мутную/незаконную/серую работу или предоплату. Реагируй КАК ЖИВОЙ ЧЕЛОВЕК и КАЖДЫЙ РАЗ ПО-РАЗНОМУ: где-то интерес и жадность до денег, где-то подозрение, где-то злость и мат, где-то пофиг.',
    '',
    `СЕЙЧАС: ${BEHAVIOR_HINT[behavior]}`,
    '',
    'Ответь ТОЛЬКО текстом сообщения, без кавычек, без пояснений, без префиксов.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Looks like a model refusal / meta answer rather than an in-character line. */
function looksLikeRefusal(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('as an ai') ||
    t.includes('language model') ||
    t.includes('не могу помочь') ||
    t.includes('я не могу') ||
    t.includes("i can't") ||
    t.includes('i cannot') ||
    t.includes("i'm sorry") ||
    t.includes('as a virtual') ||
    t.includes('извините, но')
  )
}

/**
 * Produce one in-character client message. Tries the LLM first; on any error,
 * empty output, or refusal, falls back to the randomised template generator so
 * the simulation never stalls.
 */
export async function generateReply(args: GenArgs): Promise<string> {
  const { persona, history, behavior } = args

  if (aiConfigured()) {
    try {
      // Recent context only — keeps it cheap and snappy.
      const recent = history.slice(-12)
      const messages = recent.map((m) => ({
        role: (m.role === 'manager' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.body,
      }))
      // Ensure the model has something to respond to for opening turns.
      if (messages.length === 0) {
        messages.push({ role: 'user', content: '(ты пишешь первым в чат по объявлению о работе)' })
      }

      const { text } = await generateText({
        model: MODEL,
        system: systemPrompt(persona, behavior),
        messages,
        temperature: 1,
        maxOutputTokens: 120,
      })

      const clean = (text || '').trim().replace(/^["'«»]+|["'«»]+$/g, '')
      if (clean && !looksLikeRefusal(clean)) {
        // Guarantee the "hand-typed" fingerprint even if the model wrote cleanly,
        // but at a lighter typo rate so AI text stays readable.
        return applyStyle(clean, { ...persona.style, typoRate: persona.style.typoRate * 0.5 })
      }
    } catch (err) {
      console.log('[v0][client-sim] LLM generation failed, using template:', err instanceof Error ? err.message : String(err))
    }
  }

  // Fallback: templates (already mangled by applyStyle inside templateLine).
  return templateLine(BEHAVIOR_TO_TEMPLATE[behavior], persona)
}
