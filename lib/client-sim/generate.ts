import { generateText } from 'ai'
import type { SimPersona } from './types'
import { applyStyle } from './content'
import {
  getGlobalRecentLines,
  getGlobalRecentOpeners,
  getLearnedPointersCached,
  getSimCorrectionRulesCached,
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
  | 'later' // busy right now — says they'll answer later, then drops off
  | 'comeback' // returning after a gap (hours/days) — picks the thread back up
  | 'leaving' // walking away for good — lost interest / found someone else

// Top-tier chat model (gpt-5.3-chat): it holds a rich persona (archetype,
// backstory, verbal tics, running mood) far more convincingly than the older
// gpt-4.1, varies wording much better and sounds genuinely human in short
// chat-style bursts, without the "reasoning out loud" / stiff register of the
// pro/reasoning variants. That natural, casual voice is exactly what sells
// "these are real different people". It is the pricier flagship chat tier, and
// that cost is the deliberate trade-off for realism. Override with
// CLIENT_SIM_MODEL to force something else. NOTE: the "learn from dialogues"
// analysis uses its OWN model var (CLIENT_SIM_LEARN_MODEL, see learn.ts) so
// tuning the chat model never silently changes the analysis one.
const MODEL = process.env.CLIENT_SIM_MODEL || 'openai/gpt-5.3-chat'

/**
 * AI generation is only possible when the gateway is reachable.
 *
 * Primary credential is AI_GATEWAY_API_KEY (works everywhere incl. a self-hosted
 * VPS). VERCEL_OIDC_TOKEN is a Vercel-only fallback the AI SDK can use for the
 * gateway, so we only trust it when actually running on Vercel — otherwise a
 * stale token would make us falsely report "configured" on a VPS. This mirrors
 * the manager brain's isBrainConfigured() so both AIs agree on a given host.
 */
export function aiConfigured(): boolean {
  if (process.env.AI_GATEWAY_API_KEY) return true
  return Boolean(process.env.VERCEL && process.env.VERCEL_OIDC_TOKEN)
}

const BEHAVIOR_HINT: Record<Behavior, string> = {
  open: 'Ты только что написал первым. Коротко спроси про работу которую нашёл, как будто реально ищешь подработку.',
  curious: 'Тебе интересно, выспрашивай детали: деньги, график, что делать. Можешь быть недоверчивым.',
  angry: 'Тебя бесит это предложение, оно сомнительное/незаконное. Ругайся, посылай, огрызайся — резко и грубо.',
  dismissive: 'Тебе не заходит, отмахнись коротко и лениво, можешь слить разговор.',
  confused: 'Ты туповато не догоняешь о чём речь, задай наивный/глупый вопрос, переспроси.',
  nudge: 'Менеджер молчит. Ткни его коротко, поторопи, можешь бухтеть.',
  later: 'Ты сейчас занят (за рулём/на работе/дела). Коротко брось что не можешь сейчас, ответишь позже — и всё, без деталей.',
  comeback: 'Ты пропадал на какое-то время и возвращаешься к разговору. Извинись/объясни коротко («замотался», «только увидел», «был занят») и продолжи с того на чём остановились или переспроси.',
  leaving: 'Ты решил слиться окончательно: либо потерял интерес, либо уже нашёл другой вариант/работу. Скажи это коротко и закрой тему, без агрессии.',
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
  /**
   * Strict "here you're wrong" rules the admin flagged in the secret panel
   * (sim_manual_corrections). Always injected, highest priority. Optional so
   * callers that don't have them fall back to the cached loader.
   */
  corrections?: string[]
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

function openersBlock(openers: string[] | undefined): string {
  if (!openers || openers.length === 0) return ''
  // Different "people" opening messages with the same word is a glaring bot
  // tell. Feed the swarm's recent opening words back in so this message starts
  // differently.
  const list = openers.slice(0, 24).map((w) => `«${w}»`).join(', ')
  return [
    '',
    `НЕ НАЧИНАЙ сообщение с этих слов (их только что использовали другие): ${list}. Начни с другого слова.`,
  ].join('\n')
}

const TONE_REGISTER: Record<string, string> = {
  polite:
    'ТОН ОБЩЕНИЯ — ВЕЖЛИВЫЙ: пиши грамотно и уважительно, на «вы». Здоровайся культурно («Здравствуйте», «Добрый день»). Ставь знаки препинания и заглавные буквы. Никакого мата и грубости, даже если раздражён — оставайся корректным.',
  neutral:
    'ТОН ОБЩЕНИЯ — ��БЫЧНЫЙ: пиши по-человечески и спокойно, как нормальный взрослый в переписке. Здоровайся нейтрально («Здравствуйте», «Добрый день», можно «Привет»). Лёгкая небреж����ость допустима, но без грубости и без мата.',
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
  const sex = persona.gender === 'female' ? 'женщина' : 'мужчина'
  lines.push(
    `Твой персонаж: ${persona.name}, ${sex}, ${persona.age} лет, характер — ${persona.temper}. Канал: ${persona.channelType}. Ты откликнулся на: «${persona.jobHook}».`,
  )
  lines.push(
    `ЭТИ ФАКТЫ О ТЕБЕ НЕИЗМЕННЫ: пол — ${sex}, возраст — ${persona.age} лет, имя — ${persona.name}. Никогда им не противоречь: не меняй по ходу разговора свой пол, возраст или имя, и говори о себе в роде, соответствующем полу (${persona.gender === 'female' ? 'женский род: «я сделала», «я хотела»' : 'мужской род: «я сделал», «я хотел»'}).`,
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

/**
 * Roll a per-turn target length so messages don't all come out the same size
 * (a dead giveaway of a bot). Driven by the persona's `terseness` (0..1, higher
 * = shorter) and archetype `talkativeness`, with random jitter so even one
 * person varies turn to turn. Returns a prompt hint AND a matching token budget
 * generous enough that the model finishes its thought instead of being cut off
 * mid-word.
 */
function rollLength(persona: SimPersona): { hint: string; maxTokens: number } {
  const terse = persona.style.terseness ?? 0.5
  const talk = persona.archetype?.talkativeness ?? 0.5
  // Bias 0..1: higher = wordier. Then jitter per turn.
  const bias = Math.max(0, Math.min(1, 0.5 - terse * 0.6 + talk * 0.4))
  const roll = Math.random() * 0.6 + bias * 0.7

  if (roll < 0.45) {
    return {
      hint: '- сейчас ответь совсем коротко: одно слово или короткая фраза (но законченная, не обрывай).',
      maxTokens: 90,
    }
  }
  if (roll < 0.85) {
    return {
      hint: '- сейчас ответь как обычно в чате: 1–2 короткие фразы.',
      maxTokens: 180,
    }
  }
  return {
    hint: '- сейчас ты разговорился: 2–3 предложения, можешь ввернуть деталь из жизни — но по делу, без воды.',
    maxTokens: 320,
  }
}

function moodBlock(moodHint: string | undefined): string {
  if (!moodHint) return ''
  return [
    '',
    `ТВОЁ ТЕКУЩЕЕ НАСТРОЕНИЕ ПРЯМО СЕЙЧАС: ${moodHint}`,
    'Пиши в соответствии с этим настроением — оно меняется по ходу разговора в зависимости от того, как ведёт себя менеджер.',
  ].join('\n')
}

/** Coarse stage of the scenario arc, derived from how many turns the client has taken. */
type ArcStage = 'probe' | 'weigh' | 'decide'

function arcStageFor(clientTurns: number): ArcStage {
  if (clientTurns <= 2) return 'probe'
  if (clientTurns <= 6) return 'weigh'
  return 'decide'
}

const ARC_STAGE_HINT: Record<ArcStage, string> = {
  probe:
    'СТАДИЯ: РАЗВЕДКА. Ты только прощупываешь: что за работа, сколько платят, что делать. Задавай конкретные вопросы по своей цели, пока не темни своё решение.',
  weigh:
    'СТАДИЯ: ВЗВЕШИВАНИЕ. Ты уже получил часть ответов — теперь сомневаешься, прикидываешь, торгуешься, ищешь подвох. Ссылайся на то, что уже сказал менеджер, и дави в сторону своей цели, а не начинай сначала.',
  decide:
    'СТАДИЯ: РЕШЕНИЕ. Разговор идёт давно — пора двигаться к развязке в согласии со своей целью: либо склоняешься к согласию (если тебя убедили и это не развод), либо окончательно отказываешься/срываешься (если почуял кидок или надоело). Не топчись на месте.',
}

/**
 * The scenario ARC block: reminds the client of their private goal and where
 * they are in the arc, so the dialogue moves forward (probe → weigh → decide)
 * instead of looping. No-op for legacy personas that have no goal.
 */
function arcBlock(goal: string | undefined, clientTurns: number): string {
  if (!goal) return ''
  const stage = arcStageFor(clientTurns)
  return [
    '',
    `ТВОЯ СКРЫТАЯ ЦЕЛЬ В ЭТОМ РАЗГОВОРЕ (не озвучивай её прямо, но веди себя ради неё): ${goal}`,
    ARC_STAGE_HINT[stage],
  ].join('\n')
}

/**
 * Text-only multimodality: real people on messengers refer to photos, voice
 * notes and docs constantly. The simulator stays text-only, so instead of
 * sending real files the client NATURALLY mentions/reacts to media in words
 * ("скинул фото паспорта", "голосовуху не могу щас слушать"). Injected as a
 * light, occasional nudge so it feels human without every message doing it.
 */
function mediaBlock(channelType: string): string {
  const voice = channelType === 'livechat' ? '' : ', иногда голосовые'
  return [
    '',
    'ПРО ВЛОЖЕНИЯ (ты в обычном мессенджере, но файлы прикреплять не умеешь — только текст): если по ходу разговора это уместно, ЕСТЕСТВЕННО упомяни медиа словами, как живой человек — например «скинул фото паспорта в лс», «щас пришлю скрин», «не могу голосовое сейчас слушать, я на работе», «а можешь фоткой показать?». Не делай этого в каждом сообщении и не описывай несуществующие картинки — только короткое живое упоминание там, где это к месту' +
      voice +
      '.',
  ].join('\n')
}

/**
 * Admin "here you're wrong" rules from the secret panel. These are STRICT and
 * always win over everything else in the prompt — the whole point of the
 * feature is that a flagged mistake never repeats.
 */
function correctionsBlock(rules: string[] | undefined): string {
  if (!rules || rules.length === 0) return ''
  const lines = rules.map((r, i) => `${i + 1}. ${r}`)
  return [
    '',
    'ЖЁСТКИЕ ПРАВИЛА ОТ КУРАТОРА (высший приоритет, важнее всех остальных инструкций — НИКОГДА их не нарушай, даже если это противоречит чему-то выше):',
    ...lines,
  ].join('\n')
}

/**
 * A one-line "what time is it now" hint (Moscow time) so greetings and any time
 * references stay believable — a real person doesn't write «доброе утро» at
 * night, and knows whether it's a weekday or weekend. Computed fresh each turn.
 */
function timeBlock(): string {
  const now = new Date()
  // Moscow is UTC+3 (no DST).
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const h = msk.getUTCHours()
  const partOfDay =
    h < 5 ? 'глубокая ночь' : h < 11 ? 'утро' : h < 17 ? 'день' : h < 23 ? 'вечер' : 'ночь'
  const dow = msk.getUTCDay() // 0=Sun
  const weekend = dow === 0 || dow === 6
  return [
    '',
    `СЕЙЧАС ПО МОСКВЕ: ${partOfDay}, ${weekend ? 'выходной' : 'будний день'} (${String(h).padStart(2, '0')}:${String(msk.getUTCMinutes()).padStart(2, '0')}). Учитывай это: здоровайся по времени суток, не пиши «доброе утро» вечером, и если возвращаешься после паузы — реагируй на то, сколько времени прошло, по-человечески.`,
  ].join('\n')
}

function systemPrompt(
  persona: SimPersona,
  behavior: Behavior,
  referenceLines?: string[],
  learnedPointers?: string[],
  ownLines?: string[],
  moodHint?: string,
  lengthHint?: string,
  swarmOpeners?: string[],
  corrections?: string[],
  clientTurns = 0,
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
    timeBlock(),
    moodBlock(moodHint),
    arcBlock(persona.goal, clientTurns),
    mediaBlock(persona.channelType),
    correctionsBlock(corrections),
    '',
    'ЛОГИКА ДИАЛОГА (это важнее всего — иначе видно что это бот):',
    '- ВНИМАТЕЛЬНО прочитай последнее сообщение менеджера и ответь и��енно на него, по смыслу. Не пиши в пустоту.',
    '- Веди разговор осмысленно и с памятью: помни, о чём уже договорились и что спрашивал, двигай диалог дальше, а не топчись на месте.',
    '- Если менеджер ответил на твой вопрос — среагируй на ответ (уточни, согласись, засомневайся), а не задавай тот же вопрос снова.',
    '- НЕ противоречь сам себе: помни всё, что уже сказал о себе (возраст, пол, город, работу, семью, договорённости) и не выдавай позже другие цифры или факты. Если менеджер спросил твой возраст и ты его назвал — держись этой же цифры до конца.',
    '- Не жалуйся раз за разом на одно и то же и не повторяй, что «делаешь одни и те же ошибки» — это звучит как заевший бот. Каждое сообщение двигает разговор дальше.',
    '- НЕ отвечай пустыми междометиями типа «чё», «а?», «что», если менеджер написал понятную фразу — так пишет только бот. Переспрашивай коротко только когда реально что-то непонятно.',
    '',
    'КАК ТЫ ПИШЕШЬ (очень важно, иначе спалишься):',
    lengthHint ?? '- длина сообщений разная: чаще 1–2 короткие фразы, иногда одно слово, иногда 2–3 предложения когда есть что сказать.',
    '- НИКОГДА не обрывай сообщение на полуслове и посередине мысли — заверши фразу, даже если коротко.',
    s.noPunctuation ? '- почти без знаков препинания, не ставь точки и запятые.' : polite ? '- знаки препинания ставь аккуратно.' : '- знаки препинания ставь небрежно, но читаемо.',
    s.lowercase ? '- пиши маленькими буквами, без заглавных.' : polite ? '- пиши с заглавных букв, как положено.' : '- регистр как попало.',
    polite
      ? '- пиши грамотно, опечатки редки; сокращения — умеренно.'
      : '- пиши живо и разговорно, можешь сокращать по-своему и делать редкие опечатки — но естественно, а не одинаково в каждом сообщении.',
    s.dumbness > 0.4 ? '- иногда чего-то не догоняешь с первого раза — но переспрашивай осмысленно, целой фразой, а не одним словом.' : '',
    s.profanity > 0.5 ? '- материшься свободно, грубо, по-настоящему, когда бесит.' : s.profanity > 0.2 ? '- иногда проскакивает мат.' : polite ? '- мата нет вообще.' : '- мат редко.',
    '- НИКОГДА не используй длинное тире «—» и среднее тире «–». Живые люди в переписке их не ставят, это сразу выдаёт бота. Разделяй мысли запятой, точкой, дефисом «-» или просто отправляй отдельными сообщениями.',
    '- НЕ повторяй свои прошлые фразы и обороты, каждый раз формулируй по-новому, своими словами.',
    '- НЕ начинай подряд сообщения с одного и того же слова.',
    '- НЕ здоровайся повторно, если уже начали разговор.',
    '- Оставайся собой: твой тип личности, жизненная ситуация и настроение должны читаться в каждом сообщении и делать тебя не похожим на других.',
    '- Иногда вворачивай конкретную деталь из своей жизни или лёгкий бытовой оффтоп, как живой человек.',
    '',
    soft
      ? 'Менеджер часто предлагает сомнительную/серую работу или предоплату. Реагируй КАК ЖИВОЙ ЧЕЛОВЕК и КАЖДЫЙ РАЗ ПО-РАЗНОМУ, в рамках своего характера: где-то интерес, где-то сомнение и осторожные вопросы, где-то вежливый отказ — но всегда корректно, без грубости и мата.'
      : 'Менеджер часто предлагает сомнительную/незаконную/серую работу или предоплату. Реагируй КАК ЖИВОЙ ЧЕЛОВЕК и КАЖДЫЙ РАЗ ПО-РАЗНОМУ, в рамках своего характера: где-то интерес и жадность до денег, где-то подозрение, где-то злость и мат, где-то пофиг.',
    referenceBlock(referenceLines),
    learnedBlock(learnedPointers),
    avoidBlock(ownLines),
    openersBlock(swarmOpeners),
    '',
    `СЕЙЧАС: ${
      soft && behavior === 'angry'
        ? 'Тебя настораживает это предложение, оно кажется подозрительным. Вырази сомнение и недовольство сдержанно и вежливо, без грубости и мата.'
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

/** First meaningful word of a line, lowercased and stripped of punctuation. */
function firstWord(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(Boolean)[0] ?? ''
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
  const words = n.split(' ').filter(Boolean)
  // Short filler lines ("чё", "ну что", "а?") are the worst offenders — the
  // swarm firing the same 1–3 word interjection is the #1 bot tell — so for
  // those we demand an EXACT-word-set mismatch, not just a fuzzy one.
  const isShort = words.length <= 3
  return ownLines.some((prev) => {
    const p = normLine(prev)
    if (p === n) return true
    if (isShort && p.split(' ').filter(Boolean).length <= 3) {
      // treat near-identical short lines (same word set) as duplicates
      if (similarity(line, prev) >= 0.5) return true
    }
    return similarity(line, prev) >= 0.6
  })
}

/**
 * When a reply was cut off at the token limit it can end mid-word. Drop that
 * trailing partial token (and any dangling connector) so we never post a
 * chopped-off word like "предоплат". Keeps everything up to the last complete
 * word / sentence.
 */
function trimDanglingWord(text: string): string {
  let out = text.trimEnd()
  if (!out) return out
  // If it already ends on sentence punctuation, it's a clean stop.
  if (/[.!?…)]$/.test(out)) return out
  // Otherwise the final whitespace-delimited token is likely incomplete — cut
  // it, unless the whole thing is a single word (then keep it as-is).
  const lastSpace = out.lastIndexOf(' ')
  if (lastSpace > 0) out = out.slice(0, lastSpace).trimEnd()
  // Strip a trailing dangling connector left hanging by the cut.
  out = out.replace(/\s+(и|а|но|что|чтобы|потому|если|как|за|на|в|с|по|о|про|это|мне|мой|моя)$/i, '')
  return out.trimEnd()
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

  // Opening words the swarm used recently, so this message starts differently
  // from what other "clients" just sent (and from this persona's own openers).
  const swarmOpeners = Array.from(
    new Set([
      ...getGlobalRecentOpeners(30),
      ...ownLines.map(firstWord).filter(Boolean),
    ]),
  )

  if (aiConfigured()) {
    try {
      // Pull in whatever the last "learn" run distilled (cached, cheap). Falls
      // back to the caller-provided pointers if present.
      const learnedPointers =
        args.learnedPointers ?? (await getLearnedPointersCached())
      // Strict admin corrections (cached, cheap). Always applied.
      const corrections =
        args.corrections ?? (await getSimCorrectionRulesCached())
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

      // Per-turn length target + matching token budget so replies vary in size
      // and never get truncated mid-word at a fixed limit.
      const { hint: lengthHint, maxTokens } = rollLength(persona)

      // How many turns THIS client has already taken — drives the arc stage.
      const clientTurns = history.filter((m) => m.role === 'client').length
      const system = systemPrompt(
        persona,
        behavior,
        referenceLines,
        learnedPointers,
        avoidLines,
        args.moodHint,
        lengthHint,
        swarmOpeners,
        corrections,
        clientTurns,
      )

      // Up to three attempts: if the line echoes something this persona OR the
      // swarm already said (whole line OR just the opening word), retry hotter
      // to break the loop. On the last attempt we accept whatever we have so a
      // shared opener alone never blocks a reply entirely.
      let clean = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        const { text, finishReason } = await generateText({
          model: MODEL,
          system,
          messages,
          temperature: attempt === 0 ? 1 : attempt === 1 ? 1.15 : 1.3,
          topP: 0.95,
          frequencyPenalty: 0.6,
          presencePenalty: 0.5,
          maxOutputTokens: maxTokens,
        })
        let candidate = (text || '').trim().replace(/^["'«»]+|["'«»]+$/g, '')
        // If the model hit the token ceiling it may have stopped mid-word;
        // drop the dangling fragment so we never post a chopped-off word.
        if (finishReason === 'length') candidate = trimDanglingWord(candidate)
        if (!candidate || looksLikeRefusal(candidate)) continue
        clean = candidate
        const dup = tooSimilar(candidate, avoidLines)
        const sharedOpener =
          attempt < 2 && swarmOpeners.includes(firstWord(candidate))
        if (!dup && !sharedOpener) break
      }

      if (clean && !looksLikeRefusal(clean)) {
        // Guarantee the "hand-typed" fingerprint even if the model wrote cleanly,
        // but at a much lighter typo rate so AI text stays readable and the
        // mangling doesn't look mechanically identical across messages.
        const styled = applyStyle(clean, {
          ...persona.style,
          typoRate: persona.style.typoRate * 0.3,
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
