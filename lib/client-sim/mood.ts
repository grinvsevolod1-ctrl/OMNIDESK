import type { SimPersona } from './types'

/**
 * Emotional + memory model for a simulated client.
 *
 * The mood is recomputed from scratch every turn by reading the transcript, so
 * a persona's state genuinely evolves with what the manager does: it warms up
 * when the manager is helpful and concrete, and sours when the manager stalls,
 * repeats itself, dodges questions, or pushes the classic "pay/att data first"
 * scam. This is what makes the same archetype feel different across two
 * conversations — the arc depends on the other side.
 *
 * Everything here is pure and deterministic-ish (no I/O), so it's cheap to run
 * on every tick and trivial to test.
 */

export interface MoodResult {
  /** 0..1 — how wound-up/frustrated the persona is right now. */
  frustration: number
  /** 0..1 — how interested/engaged they still are. */
  interest: number
  /** true once they suspect a scam (prepay / data-first / dodging). */
  suspicious: boolean
  /** Extra weight to add to the "angry" behaviour roll. */
  angerBoost: number
  /** Extra weight to add to the "dismissive" behaviour roll. */
  dismissBoost: number
  /** One-line, in-character mood description injected into the LLM prompt. */
  hint: string
}

type Turn = { role: 'manager' | 'client'; body: string }

/** Manager phrasing that signals the classic shady ask. */
const SCAM_RE =
  /предоплат|предоплату|залог|внес|внести|оплати|оплату|переве|перевод|карт[уые]|киви|qiwi|комисс|актив(ир|аци)|страхов|взнос|подтверд.*оплат|пополн|гарантийн/i

/** Manager phrasing that reads as evasive / non-answers. */
const DODGE_RE =
  /(поймёте позже|потом объясн|всё расскаж.*потом|напишите.*личк|это не важно|неважно сколько|узнаете когда|позже узнаешь|всё потом)/i

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function similarity(a: string, b: string): number {
  const wa = new Set(norm(a).split(' ').filter(Boolean))
  const wb = new Set(norm(b).split(' ').filter(Boolean))
  if (wa.size === 0 || wb.size === 0) return 0
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / (wa.size + wb.size - inter)
}

/** Did the manager send two near-identical messages (copy-paste feel)? */
function managerRepeated(managerLines: string[]): boolean {
  for (let i = 1; i < managerLines.length; i++) {
    if (similarity(managerLines[i], managerLines[i - 1]) >= 0.6) return true
  }
  return false
}

/** Did the client ask essentially the same thing more than once (ignored)? */
function clientReAsked(clientLines: string[]): boolean {
  const questions = clientLines.filter((l) => l.includes('?') || /скольк|когда|что.*делать|какая|где/i.test(l))
  for (let i = 0; i < questions.length; i++) {
    for (let j = i + 1; j < questions.length; j++) {
      if (similarity(questions[i], questions[j]) >= 0.5) return true
    }
  }
  return false
}

/** Does any manager line actually contain a concrete number (money/hours)? */
function managerGaveNumbers(managerLines: string[]): boolean {
  return managerLines.some((l) => /\d/.test(l))
}

/**
 * Compute the persona's live mood from the conversation so far.
 *
 * `manualBoost` lets the engine add situational pressure (e.g. the manager has
 * been silent a long time) without this module needing timing access.
 */
export function computeMood(
  persona: SimPersona,
  history: Turn[],
  turns: number,
): MoodResult {
  const managerLines = history.filter((h) => h.role === 'manager').map((h) => h.body)
  const clientLines = history.filter((h) => h.role === 'client').map((h) => h.body)

  // Baselines from the persona itself.
  const moodBias = persona.archetype?.moodBias ?? 0
  const patienceBias = persona.archetype?.patienceBias ?? 0
  const aggr = persona.style.profanity // proxy for how hot-tempered they write

  // Start slightly negative for grumpy archetypes, slightly positive otherwise.
  let frustration = clamp01(0.15 - moodBias * 0.5 + aggr * 0.15)
  let interest = clamp01(0.6 + moodBias * 0.3 - aggr * 0.1)
  let suspicious = false

  // --- Signals from the manager's behaviour ---------------------------------
  const askedScam = managerLines.some((l) => SCAM_RE.test(l))
  const dodged = managerLines.some((l) => DODGE_RE.test(l))
  const repeated = managerRepeated(managerLines)
  const reAsked = clientReAsked(clientLines)
  const noNumbers = managerLines.length >= 2 && !managerGaveNumbers(managerLines)

  if (askedScam) {
    suspicious = true
    frustration += 0.3
    interest -= 0.15
  }
  if (dodged) {
    frustration += 0.15
    interest -= 0.1
  }
  if (repeated) frustration += 0.2
  if (reAsked) frustration += 0.2
  if (noNumbers) frustration += 0.1

  // Patience erodes with conversation length; patient archetypes erode slower.
  const fatigue = Math.max(0, turns - 2) * (0.05 - patienceBias * 0.03)
  frustration += fatigue

  // A helpful, concrete manager warms interest back up.
  if (managerGaveNumbers(managerLines) && !askedScam && !repeated) {
    interest += 0.15
    frustration -= 0.05
  }

  frustration = clamp01(frustration)
  interest = clamp01(interest)

  // Behaviour-roll nudges derived from the state.
  const angerBoost = Math.round(frustration * 10) + (suspicious ? 3 : 0)
  const dismissBoost = interest < 0.3 ? 4 : interest < 0.5 ? 2 : 0

  return {
    frustration,
    interest,
    suspicious,
    angerBoost,
    dismissBoost,
    hint: buildHint({
      frustration,
      interest,
      suspicious,
      repeated,
      reAsked,
      dodged,
      turns,
    }),
  }
}

function buildHint(x: {
  frustration: number
  interest: number
  suspicious: boolean
  repeated: boolean
  reAsked: boolean
  dodged: boolean
  turns: number
}): string {
  const parts: string[] = []

  if (x.frustration >= 0.75) parts.push('ты уже сильно раздражён и на грани того, чтобы послать')
  else if (x.frustration >= 0.5) parts.push('ты заметно раздражён и недоволен')
  else if (x.frustration >= 0.3) parts.push('ты слегка напряжён, терпение на исходе')
  else parts.push('ты пока спокоен')

  if (x.suspicious) parts.push('подозреваешь развод — с тебя просят деньги/данные вперёд')
  if (x.repeated) parts.push('менеджер повторяет одно и то же, это бесит')
  if (x.reAsked) parts.push('тебе так и не ответили на твой вопрос — напомни, ты уже спрашивал')
  if (x.dodged) parts.push('менеджер юлит и не отвечает прямо')

  if (x.interest >= 0.6 && x.frustration < 0.4) parts.push('но деньги тебе всё ещё интересны')
  else if (x.interest < 0.3) parts.push('интерес почти пропал, готов слить разговор')

  return parts.join('; ') + '.'
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
