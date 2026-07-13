import { generateText } from 'ai'
import type { SimPersona } from './types'
import { applyStyle } from './content'
import {
  getGlobalRecentLines,
  getLearnedPointersCached,
  rememberGlobalLine,
} from './store'

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

// Full gpt-4.1 (not mini): it holds a rich persona — archetype, backstory,
// verbal tics, running mood — far more convincingly and varies its wording
// much better, which is exactly what sells "these are real different people".
// Pricier than the mini, but that's the deliberate trade-off for realism.
// Override with CLIENT_SIM_MODEL to force something else.
const MODEL = process.env.CLIENT_SIM_MODEL || 'openai/gpt-4.1'

/** AI generation is only possible when the gateway key is present. */
export function aiConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)
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
  /** Real client lines sampled from past dialogues, used as a style reference. */
  referenceLines?: string[]
  /** Distilled pointers from the "learn from all dialogues" run. */
  learnedPointers?: string[]
  /**
   * Live one-line mood/state description computed by the engine from the
   * conversation so far (e.g. «раздражён: менеджер тянет и просит предоплату»).
   * Injected verbatim so the persona's emotional state evolves turn to turn.
   */
  moodHint?: string
}

function referenceBlock(lines: string[] | undefined): string {
  if (!lines || lines.length === 0) return ''
  // A handful of real examples is enough to anchor the voice without letting
  // the model copy them verbatim.
  const sample = lines.slice(0, 10).map((l) => `- ${l}`).join('\n')
  return [
    '',
    'ВОТ КАК РЕАЛЬНЫЕ ЛЮДИ ПИСАЛИ В ЭТОТ КАНАЛ (это образец живого стиля — впитай манеру, длину, тон, ошибки; НЕ копируй дословно, НЕ повторяй эти фразы):',
    sample,
  ].join('\n')
}

function learnedBlock(pointers: string[] | undefined): string {
  if (!pointers || pointers.length === 0) return ''
  const list = pointers.slice(0, 12).map((p) => `- ${p}`).join('\n')
  return [
    '',
    'ВЫВОДЫ ИЗ АНАЛИЗА РЕАЛЬНЫХ ДИАЛОГОВ (следуй этим наблюдениям, чтобы звучать максимально правдоподобно):',
    list,
  ].join('\n')
}

function avoidBlock(avoidLines: string[] | undefined): string {
  if (!avoidLines || avoidLines.length === 0) return ''
  // Show recently-used lines (this persona's own + what other "clients" just
  // sent) so the model actively avoids reusing the same openings/words — the
  // #1 tell of a bot farm.
  const list = avoidLines.slice(-14).map((l) => `- ${l}`).join('\n')
  return [
    '',
    'ЭТИ ФРАЗЫ УЖЕ ЗВУЧАЛИ НЕДАВНО (НЕ повторяй их и похожие обороты/слова, скажи совершенно иначе, по-своему):',
    list,
  ].join('\n')
}

const TONE_REGISTER: Record<string, string> = {
  polite:
    'ТОН ОБЩЕНИЯ — ВЕЖЛИВЫЙ: пиши грамотно и уважительно, на «вы». Здоровайся культурно («Здравствуйте», «Добрый день»). Ставь знаки препинания и заглавные буквы. Никакого мата и грубости, даже если раздражён — оставайся корректным.',
  neutral:
    'ТОН ОБЩЕНИЯ — ОБЫЧНЫЙ: пиши по-человечески и спокойно, как нормальный взрослый в переписке. Здоровайся нейтрально («Здравствуйте», «Добрый день», можно «Привет»). Лёгкая небрежность допустима, но без грубости и без мата.',
  rough:
    'ТОН ОБЩЕНИЯ — РАЗВЯЗНЫЙ: пиши по-простому и панибратски («привет», «здарова», «чё», «скок»). Грубость и мат допустимы по настроению.',
  mixed:
    'ТОН ОБЩЕНИЯ — СВОБОДНЫЙ: от вежливого до развязного, как выйдет у этого персонажа.',
}

/**
 * Rich character sheet. This is what turns "generic angry client #4" into a
 * specific person: archetype behaviour, backstory, traits and verbal tics all
 * go into the prompt so the model writes grounded, individual messages.
 */
function personaBlock(persona: SimPersona): string {
  const lines: string[] = []
  lines.push(
    `Твой персонаж: ${persona.name}, ${persona.age} лет, характер — ${persona.temper}. Канал: ${persona.channelType}. Ты откликнулся на: «${persona.jobHook}».`,
  )

  if (persona.archetype) {
    lines.push(`ТИП ЛИЧНОСТИ — ${persona.archetype.label}: ${persona.archetype.brief}`)
  }

  if (persona.traits && persona.traits.length > 0) {
    lines.push(`Черты характера: ${persona.traits.join(', ')}.`)
  }

  if (persona.backstory) {
    const b = persona.backstory
    lines.push(
      `Твоя жизнь (используй эти детали естественно, не вываливай всё сразу): ${b.occupation}, из «${b.region}». Ищешь работу потому что ${b.motivation}. Про себя: ${b.detail}.`,
    )
  }

  if (persona.quirks && persona.quirks.length > 0) {
    lines.push(
      `Слова-паразиты и манера речи (вставляй иногда, естественно, не в каждое сообщение): ${persona.quirks.map((q) => `«${q}»`).join(', ')}.`,
    )
  }

  return lines.join('\n')
}

function moodBlock(moodHint: string | undefined): string {
  if (!moodHint) return ''
  return [
    '',
    `ТВОЁ ТЕКУЩЕЕ НАСТРОЕНИЕ ПРЯМО СЕЙЧАС: ${moodHint}`,
    'Пиши в соответствии с этим настроением — оно меняется по ходу разговора в зависимости от того, как ведёт себя менеджер.',
  ].join('\n')
}

function systemPrompt(
  persona: SimPersona,
  behavior: Behavior,
  referenceLines?: string[],
  learnedPointers?: string[],
  ownLines?: string[],
  moodHint?: string,
): string {
  const s = persona.style
  const tone = persona.tone ?? 'mixed'
  const polite = tone === 'polite'
  const soft = tone === 'polite' || tone === 'neutral'
  return [
    'Ты играешь РОЛЬ обычного русского человека, который написал в мессенджер по объявлению о работе.',
    'Это внутренний тренажёр: ты имитируешь клиента, чтобы проверить менеджера. НИКОГДА не выходи из роли, не признавайся что ты ИИ или бот, не упоминай что это тест.',
    '',
    personaBlock(persona),
    '',
    TONE_REGISTER[tone] ?? TONE_REGISTER.mixed,
    moodBlock(moodHint),
    '',
    'КАК ТЫ ПИШЕШЬ (очень важно, иначе спалишься):',
    '- как в реальном чате: коротко, 1 фраза, редко 2.',
    s.noPunctuation ? '- почти без знаков препинания, не ставь точки и запятые.' : polite ? '- знаки препинания ставь аккуратно.' : '- знаки препинания ставь небрежно.',
    s.lowercase ? '- пиши маленькими буквами, без заглавных.' : polite ? '- пиши с заглавных букв, как положено.' : '- регистр как попало.',
    polite
      ? '- пиши грамотно, опечатки редки; сокращения — умеренно.'
      : '- допускай опечатки и ошибки, пиши разговорно и коряво, сокращай слова (щас, норм, че, скок, мб).',
    s.dumbness > 0.4 ? '- иногда туповато переспрашивай и не догоняй с первого раза.' : '',
    s.profanity > 0.5 ? '- материшься свободно, грубо, по-настоящему, когда бесит.' : s.profanity > 0.2 ? '- иногда проскакивает мат.' : polite ? '- мата нет вообще.' : '- мат редко.',
    '- НЕ повторяй свои прошлые фразы, каждый раз говори по-другому.',
    '- НЕ здоровайся повторно, если уже начали разговор.',
    '- Оставайся собой: твой тип личности и настроение должны читаться в каждом сообщении.',
    '- Иногда неси лёгкую бытовую чушь/оффтоп, как живой человек.',
    '',
    soft
      ? 'Менеджер часто предлагает мутную/серую работу или предоплату. Реагируй КАК ЖИВОЙ ЧЕЛОВЕК и КАЖДЫЙ РАЗ ПО-РАЗНОМУ, в рамках своего характера: где-то интерес, где-то сомнение и осторожные вопросы, где-то вежливый отказ — но всегда корректно, без грубости и мата.'
      : 'Менеджер часто предлагает мутную/незаконную/серую работу или предоплату. Реагируй КАК ЖИВОЙ ЧЕЛОВЕК и КАЖДЫЙ РАЗ ПО-РАЗНОМУ, в рамках своего характера: где-то интерес и жадность до денег, где-то подозрение, где-то злость и мат, где-то пофиг.',
    referenceBlock(referenceLines),
    learnedBlock(learnedPointers),
    avoidBlock(ownLines),
    '',
    `СЕЙЧАС: ${
      soft && behavior === 'angry'
        ? 'Тебя настораживает это предложение, оно кажется мутным. Вырази сомнение и недовольство сдержанно и вежливо, без грубости и мата.'
        : BEHAVIOR_HINT[behavior]
    }`,
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

/** Normalise a line for fuzzy comparison (lowercase, strip punctuation). */
function normLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Rough word-overlap similarity (Jaccard) between two lines, 0..1. Used to
 * catch the model repeating itself even when a few words differ.
 */
function similarity(a: string, b: string): number {
  const wa = new Set(normLine(a).split(' ').filter(Boolean))
  const wb = new Set(normLine(b).split(' ').filter(Boolean))
  if (wa.size === 0 || wb.size === 0) return 0
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / (wa.size + wb.size - inter)
}

/** True when `line` is too close to any of the persona's recent lines. */
function tooSimilar(line: string, ownLines: string[]): boolean {
  const n = normLine(line)
  return ownLines.some((prev) => {
    const p = normLine(prev)
    return p === n || similarity(line, prev) >= 0.6
  })
}

/**
 * Produce one in-character client message with the LLM. Returns `null` when the
 * AI is unavailable / errored / refused / produced nothing usable — callers
 * MUST then stay silent and retry later, NEVER post a canned template. This is
 * a deliberate product decision: templated fallback text reads robotic and
 * repetitive ("отвечает как долбоёб"), so it's better to say nothing than to
 * expose obviously-generated filler. Includes an anti-repetition guard: the
 * model is shown its own + the swarm's recent lines to avoid, and near-
 * duplicate output triggers a hotter retry before we accept it.
 */
export async function generateReply(args: GenArgs): Promise<string | null> {
  const { persona, history, behavior, referenceLines } = args

  // The persona's own past lines — used both to steer the prompt away from
  // repetition and to reject near-duplicate generations.
  const ownLines = history
    .filter((m) => m.role === 'client')
    .map((m) => m.body)

  // Population-level memory: what OTHER bots sent recently across all threads.
  // Merged with the persona's own lines so the model avoids both repeating
  // itself AND echoing what the swarm just said (the dead-giveaway of a bot
  // farm firing identical/near-identical messages).
  const avoidLines = Array.from(
    new Set([...getGlobalRecentLines(40), ...ownLines]),
  )

  if (aiConfigured()) {
    try {
      // Pull in whatever the last "learn" run distilled (cached, cheap). Falls
      // back to the caller-provided pointers if present.
      const learnedPointers =
        args.learnedPointers ?? (await getLearnedPointersCached())
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

      const system = systemPrompt(
        persona,
        behavior,
        referenceLines,
        learnedPointers,
        avoidLines,
        args.moodHint,
      )

      // Up to three attempts: if the line echoes something this persona OR the
      // swarm already said, retry hotter to break the loop.
      let clean = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        const { text } = await generateText({
          model: MODEL,
          system,
          messages,
          temperature: attempt === 0 ? 1 : attempt === 1 ? 1.15 : 1.3,
          topP: 0.95,
          frequencyPenalty: 0.6,
          presencePenalty: 0.5,
          maxOutputTokens: 120,
        })
        const candidate = (text || '').trim().replace(/^["'«»]+|["'«»]+$/g, '')
        if (!candidate || looksLikeRefusal(candidate)) continue
        clean = candidate
        if (!tooSimilar(candidate, avoidLines)) break
      }

      if (clean && !looksLikeRefusal(clean)) {
        // Guarantee the "hand-typed" fingerprint even if the model wrote cleanly,
        // but at a lighter typo rate so AI text stays readable.
        const styled = applyStyle(clean, {
          ...persona.style,
          typoRate: persona.style.typoRate * 0.5,
        })
        rememberGlobalLine(styled)
        return styled
      }
    } catch (err) {
      console.warn(
        '[client-sim] LLM generation failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // No usable AI output — stay silent (no template fallback). The engine keeps
  // the thread alive and retries on a later tick.
  return null
}
