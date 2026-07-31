import type { ChannelType } from '@/lib/types'
import type {
  SimChronotype,
  SimGender,
  SimPersona,
  SimPersonaConfig,
  SpeechFingerprint,
  SimStyle,
  SimTone,
} from './types'

import {
  AI_CLICHE_BLACKLIST,
  ANGRY,
  ARCHETYPES,
  CONFUSED,
  CURIOUS,
  DISMISSIVE,
  EMOJIS,
  EMOJI_BRACKETS,
  EMOJI_PICTURES,
  FEMALE_FIRST,
  FILLERS,
  FP_CONNECTORS,
  FP_GRAMMAR_QUIRKS,
  FP_PERSONAL_DETAILS,
  FP_SENTENCE_ENDINGS,
  FP_TYPING_HABITS,
  GOALS,
  JOB_HOOKS,
  LIFE_DETAILS,
  MALE_FIRST,
  MALE_LAST,
  MOTIVATIONS,
  NICK_SUFFIX,
  NICK_WORDS,
  OCCUPATIONS,
  OPENERS,
  PREFIXES,
  QUIRKS_POOL,
  REACTION_EMOJIS,
  REGIONS,
  SUFFIXES,
  TEMPERS,
  TYPO_ADJACENT,
} from './content/data'

/* ========================================================================= */
/*  Randomness helpers                                                       */
/* ========================================================================= */

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function chance(p: number): boolean {
  return Math.random() < p
}

export function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

/** Shuffle a copy of the array (Fisher-Yates). */
export function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/* ========================================================================= */
/*  Names & handles                                                          */
/* ========================================================================= */


function femaleLast(male: string): string {
  if (male.endsWith('ий') || male.endsWith('ой')) return male.slice(0, -2) + 'ая'
  return male + 'а'
}

/**
 * Best-effort guess of a persona's gender from a display name, so an adopted
 * dialog's persona never contradicts the name it's pinned to (e.g. «Наталья»
 * must be female). Checks the known first-name lists first, then falls back to
 * typical Russian first-name endings. Returns null when undecidable (e.g. a
 * bare @nick) so the caller can keep the randomly-rolled gender.
 */
export function inferGenderFromName(name: string | null | undefined): SimGender | null {
  if (!name) return null
  const first = name.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first) return null
  if (FEMALE_FIRST.some((n) => n.toLowerCase() === first)) return 'female'
  if (MALE_FIRST.some((n) => n.toLowerCase() === first)) return 'male'
  // Ending heuristics: most female RU first names end in -а/-я (Наталья, Ольга),
  // most male ones in a consonant/-й (Сергей, Иван). Not perfect (Никита, Илья)
  // but the known-name lists above catch the common exceptions.
  if (/(а|я)$/.test(first)) return 'female'
  if (/[бвгджзйклмнпрстфхцчшщ]$/.test(first)) return 'male'
  return null
}

// Weird telegram-nick fragments — "всякая хуйня" as requested.

function randomNick(): string {
  const base = pick(NICK_WORDS)
  const mid = chance(0.5) ? pick(NICK_WORDS) : ''
  const num = chance(0.6) ? String(randInt(1, 9999)) : pick(NICK_SUFFIX)
  const glue = chance(0.5) ? '_' : ''
  return `${base}${glue}${mid}${num}`.replace(/__+/g, '_').slice(0, 24) || 'user' + randInt(100, 999)
}

/* ========================================================================= */
/*  Job hooks — what the "client" thinks they found on the site              */
/*  Kept as fragments so the LLM (and templates) phrase them differently     */
/*  every time and never sound copy-pasted.                                  */
/* ========================================================================= */


/**
 * Lock this persona into ONE laugh/emoji register so it stays consistent across
 * the whole dialog (real people don't randomly alternate «)))» and 😂). The
 * `bracketBias` shifts the odds toward text-brackets — higher for older/formal
 * tones where picture emoji feel out of character.
 */
function rollEmojiStyle(bracketBias: number): 'brackets' | 'emoji' | 'mixed' {
  const r = Math.random()
  const b = Math.max(0, Math.min(1, bracketBias))
  if (r < 0.45 + b * 0.25) return 'brackets'
  if (r < 0.85) return 'emoji'
  return 'mixed'
}

function rollStyle(aggression: number, tone: SimTone): SimStyle {
  // aggression 0..100 raises profanity + terseness baselines.
  const a = Math.max(0, Math.min(100, aggression)) / 100

  switch (tone) {
    case 'polite':
      // Grammatical, capitalised, punctuated, no swearing.
      return {
        lowercase: false,
        noPunctuation: false,
        typoRate: Math.min(0.06, 0.01 + Math.random() * 0.05),
        profanity: 0,
        terseness: 0.2 + Math.random() * 0.3,
        dumbness: Math.random() * 0.3,
        emojiRate: chance(0.3) ? Math.random() * 0.15 : 0,
        emojiStyle: rollEmojiStyle(0.6),
      }
    case 'neutral':
      // Everyday conversational: a little sloppy, but never rude.
      return {
        lowercase: chance(0.4),
        noPunctuation: chance(0.4),
        typoRate: Math.min(0.15, 0.03 + Math.random() * 0.12),
        profanity: Math.min(0.15, a * 0.15),
        terseness: 0.3 + Math.random() * 0.4,
        dumbness: Math.random() * 0.5,
        emojiRate: chance(0.45) ? Math.random() * 0.25 : 0,
        emojiStyle: rollEmojiStyle(0.35),
      }
    case 'rough':
      // Slangy/panibratski, punctuation-light, swears scale with aggression.
      return {
        lowercase: chance(0.85),
        noPunctuation: chance(0.85),
        typoRate: Math.min(0.35, 0.08 + Math.random() * 0.27),
        profanity: Math.min(1, Math.max(0.15, a * (0.5 + Math.random() * 0.9))),
        terseness: Math.min(1, 0.4 + a * 0.4 + Math.random() * 0.3),
        dumbness: Math.random() * 0.7,
        emojiRate: chance(0.5) ? Math.random() * 0.3 : 0,
        emojiStyle: rollEmojiStyle(0.4),
      }
    default:
      // 'mixed' — the original wide random spread.
      return {
        lowercase: chance(0.7),
        noPunctuation: chance(0.75),
        typoRate: Math.min(0.35, 0.05 + Math.random() * 0.28),
        profanity: Math.min(1, Math.max(0, a * (0.4 + Math.random() * 0.9))),
        terseness: Math.min(1, 0.3 + a * 0.4 + Math.random() * 0.4),
        dumbness: Math.random() * 0.7,
        emojiRate: chance(0.5) ? Math.random() * 0.3 : 0,
        emojiStyle: rollEmojiStyle(0.4),
      }
  }
}

/**
 * Build a channel-appropriate fake client. Telegram leans on weird @nicks,
 * WhatsApp on phone-number handles, VK/MAX on id-style handles + real names.
 * Pass `personaCfg` (from sim_settings.content_config.persona) to override any
 * pool; missing or empty arrays fall back to the hardcoded data.ts defaults.
 */
export function makePersona(
  channelType: ChannelType,
  aggression: number,
  tone: SimTone = 'mixed',
  personaCfg?: SimPersonaConfig | null,
): SimPersona {
  // Helper: use operator pool if non-empty, otherwise fall back to default.
  function pool<T>(op: T[] | undefined, def: T[]): T[] {
    return op && op.length > 0 ? op : def
  }

  const archetypePool = pool(
    personaCfg?.archetypes as typeof ARCHETYPES[number][] | undefined,
    ARCHETYPES as unknown as typeof ARCHETYPES[number][],
  )
  const maleFirst   = pool(personaCfg?.maleFirstNames,   MALE_FIRST)
  const femaleFirst = pool(personaCfg?.femaleFirstNames,  FEMALE_FIRST)
  const lastNames   = pool(personaCfg?.lastNames,         MALE_LAST)
  const temperPool  = pool(personaCfg?.tempers,           TEMPERS)
  const occPool     = pool(personaCfg?.occupations,       OCCUPATIONS)
  const motivPool   = pool(personaCfg?.motivations,       MOTIVATIONS)
  const detailPool  = pool(personaCfg?.lifeDetails,       LIFE_DETAILS)
  const quirksPool  = pool(personaCfg?.quirks,            QUIRKS_POOL)
  const goalPool    = pool(personaCfg?.goals,             GOALS)

  // Pick the behavioural archetype first — it colours age, mood and pacing.
  const archetype = pick(archetypePool)

  const gender: SimGender = chance(0.55) ? 'male' : 'female'
  const first = pick(gender === 'male' ? maleFirst : femaleFirst)
  const baseLast = pick(lastNames)
  const last = gender === 'male' ? baseLast : femaleLast(baseLast)

  // Age roughly consistent with the archetype so a «Студент» isn't 50.
  const age =
    archetype.id === 'student'
      ? randInt(17, 23)
      : archetype.id === 'pensioner'
        ? randInt(58, 74)
        : archetype.id === 'mom'
          ? randInt(24, 38)
          : randInt(19, 55)

  // Hotheads / skeptics skew the effective aggression up a bit.
  const moodBias = archetype.moodBias ?? 0
  const effAggression = Math.max(
    0,
    Math.min(100, aggression + (moodBias < 0 ? -moodBias * 55 : 0)),
  )

  let name: string
  let handle: string
  let username: string | undefined

  switch (channelType) {
    case 'telegram': {
      // Often a weird nick as the display name, sometimes a real first name.
      username = randomNick()
      name = chance(0.45) ? first : chance(0.5) ? `${first} ${last}` : username
      handle = `@${username}`
      break
    }
    case 'whatsapp': {
      name = chance(0.7) ? first : `${first} ${last}`
      handle = `+7${randInt(900, 999)}${String(randInt(1000000, 9999999))}`
      break
    }
    case 'vk': {
      name = `${first} ${last}`
      username = chance(0.5) ? randomNick() : `id${randInt(1000000, 899999999)}`
      handle = `id${randInt(1000000, 899999999)}`
      break
    }
    case 'max': {
      name = first
      handle = `id${randInt(100000, 900000000)}`
      break
    }
    default: {
      // livechat / anything else — anonymous site visitor
      name = chance(0.5) ? first : `Гость ${randInt(100, 999)}`
      handle = `visitor-${randInt(100000, 999999)}`
    }
  }

  const temper = pick(temperPool)

  return {
    name,
    handle,
    username,
    gender,
    channelType,
    age,
    temper,
    jobHook: pick(JOB_HOOKS),
    tone,
    style: rollStyle(effAggression, tone),
    archetype,
    backstory: {
      occupation: pick(occPool),
      motivation: pick(motivPool),
      region: pick(REGIONS),
      detail: pick(detailPool),
    },
    quirks: shuffle(quirksPool).slice(0, randInt(0, 3)),
    traits: (() => {
      const set = new Set<string>([temper])
      while (set.size < randInt(2, 3) + 1) set.add(pick(temperPool))
      return Array.from(set)
    })(),
    goal: pick(goalPool),
    speechFingerprint: rollSpeechFingerprint(),
    // ~25% larks, ~25% owls, ~50% ordinary day-active people.
    chronotype: ((): SimChronotype => {
      const r = Math.random()
      return r < 0.25 ? 'lark' : r < 0.5 ? 'owl' : 'normal'
    })(),
  }
}

/* ========================================================================= */
/*  Speech fingerprint                                                       */
/*  Rolled once at spawn — gives every "person" a stable unique voice that   */
/*  the model stays consistent with across all turns. Optional dimensions:   */
/*  connector, grammar quirk, typing habit, sentence-ending, personal detail */
/* ========================================================================= */

/**
 * Roll a fresh speech fingerprint. Every pool item is picked independently
 * so the combination space is enormous (25×15×16×10×12 = ~720k combos) and
 * two personas almost never land on the same voice configuration.
 */
export function rollSpeechFingerprint(): SpeechFingerprint {
  return {
    connector: pick(FP_CONNECTORS),
    grammarQuirk: pick(FP_GRAMMAR_QUIRKS),
    typingHabit: pick(FP_TYPING_HABITS),
    sentenceEnding: pick(FP_SENTENCE_ENDINGS),
    // Personal detail is only added ~70% of the time — some people don't
    // volunteer life details at all, so not every persona mentions one.
    personalDetail: chance(0.7) ? pick(FP_PERSONAL_DETAILS) : undefined,
  }
}

/** Re-export so callers never need to dig into content/data.ts directly. */
export { AI_CLICHE_BLACKLIST }

/* ========================================================================= */
/*  Human-noise style mangling                                               */
/*  Applied on top of BOTH the LLM output and the templates so every line    */
/*  looks hand-typed: lowercase, dropped punctuation, believable typos.      */
/* ========================================================================= */


function typoWord(word: string): string {
  if (word.length < 3) return word
  const roll = Math.random()
  const i = randInt(0, word.length - 1)
  if (roll < 0.3 && i < word.length - 1) {
    // swap two adjacent chars
    const arr = word.split('')
    ;[arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]
    return arr.join('')
  }
  if (roll < 0.55) {
    // drop a char
    return word.slice(0, i) + word.slice(i + 1)
  }
  if (roll < 0.78) {
    // double a char
    return word.slice(0, i) + word[i] + word.slice(i)
  }
  // wrong neighbour key
  const lower = word[i].toLowerCase()
  const near = TYPO_ADJACENT[lower]
  if (near) {
    const rep = near[randInt(0, near.length - 1)]
    return word.slice(0, i) + rep + word.slice(i + 1)
  }
  return word
}


/**
 * Take a clean sentence and return a version with exactly ONE believable typo
 * in a single "real" word (len >= 4, letters only), or null if no suitable word
 * exists. Used to send a message with a slip that the persona then EDITS to fix
 * a moment later — the most human anti-bot signal there is. Deterministic-ish:
 * picks one eligible word at random and mangles just that one.
 */
export function injectSingleTypo(clean: string): string | null {
  const text = clean.trim()
  if (!text) return null
  const tokens = text.split(/(\s+)/) // keep whitespace tokens for rejoin
  // Indices of "real" words worth typoing.
  const eligible: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^[\p{L}]{4,}$/u.test(t)) eligible.push(i)
  }
  if (eligible.length === 0) return null
  const idx = eligible[randInt(0, eligible.length - 1)]
  const mangled = typoWord(tokens[idx])
  if (mangled === tokens[idx]) return null // no change produced
  tokens[idx] = mangled
  const out = tokens.join('')
  return out === text ? null : out
}

/** Pick an emoji token from the pool this persona is consistent in. */
function pickEmoji(style: SimStyle): string {
  switch (style.emojiStyle) {
    case 'brackets':
      return pick(EMOJI_BRACKETS)
    case 'emoji':
      return pick(EMOJI_PICTURES)
    default:
      return pick(EMOJIS) // legacy 'mixed' rows keep the old random behaviour
  }
}

/** Apply a persona's writing fingerprint to a clean sentence. */
/**
 * Replace typographic dashes (em «—», en «–», horizontal bar «―», figure dash,
 * and the Unicode minus «−») with human punctuation:
 *   - a dash used as a spaced separator  → a comma (reads natural in RU chat)
 *   - any other dash (line start, numeric range, glued) → a plain hyphen "-"
 * Then it repairs any doubled comma the substitution could create.
 */
function deDash(text: string): string {
  return text
    .replace(/\s+[—–―‒−]\s+/g, ', ')
    .replace(/[—–―‒−]/g, '-')
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
}

/**
 * Split a punctuation-less run-on into two chunks at a word gap near the middle
 * (with a little jitter) so no-punctuation personas still send separate
 * messages instead of one long line.
 */
function splitRunOn(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 6) return [text]
  const mid = Math.round(words.length / 2)
  const at = Math.max(2, Math.min(words.length - 2, mid + randInt(-1, 1)))
  return [words.slice(0, at).join(' '), words.slice(at).join(' ')]
}

/**
 * Break one generated reply into 1..N chat "bubbles" the way a real person
 * fires off several short messages instead of one wall of text. Most replies
 * stay a single bubble; sometimes they split into 2-3 (rarely 4). Works for
 * both punctuated and no-punctuation personas. The engine posts the first
 * bubble immediately and the rest with human "typing" gaps.
 */
export function splitIntoMessages(text: string, style: SimStyle): string[] {
  const clean = text.trim()
  if (!clean) return []

  // Very short lines are always a single bubble.
  const words = clean.split(/\s+/).filter(Boolean)
  if (clean.length < 24 || words.length < 4) return [clean]

  // People don't ALWAYS split — keep it one message a good chunk of the time.
  // Terser personas (short, clipped writers) burst into separate messages more.
  const terse = style.terseness ?? 0.5
  const pSingle = Math.max(0.2, 0.55 - terse * 0.25)
  if (chance(pSingle)) return [clean]

  // Prefer explicit line breaks, then sentence boundaries.
  let segments = clean
    .split(/\n+/)
    .flatMap((p) => p.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? [p])
    .map((s) => s.trim())
    .filter(Boolean)

  // No-punctuation text collapses to a single segment: fall back to a mid-point
  // split so these personas still burst into two messages.
  if (segments.length < 2) segments = splitRunOn(clean)
  if (segments.length < 2) return [clean]

  // Group adjacent segments into bubbles, breaking with a moderate chance and
  // capping the count so we never spray a dozen fragments.
  const maxParts = 2 + (chance(0.35) ? 1 : 0) + (chance(0.1) ? 1 : 0) // 2..4
  const parts: string[] = []
  let cur = ''
  for (const seg of segments) {
    const canBreak = cur !== '' && parts.length + 1 < maxParts
    if (canBreak && chance(0.55)) {
      parts.push(cur)
      cur = seg
    } else {
      cur = cur ? `${cur} ${seg}` : seg
    }
  }
  if (cur.trim()) parts.push(cur.trim())

  // Merge away useless 1-2 char fragments so no bubble is just punctuation.
  const bubbles: string[] = []
  for (const raw of parts) {
    const p = raw.trim()
    if (!p) continue
    if (p.length < 3 && bubbles.length > 0) {
      bubbles[bubbles.length - 1] += ` ${p}`
    } else {
      bubbles.push(p)
    }
  }
  return bubbles.length > 0 ? bubbles : [clean]
}

export function applyStyle(text: string, style: SimStyle): string {
  let out = text.trim()
  if (!out) return out

  // Kill typographic long dashes — the single biggest "written by an AI" tell.
  // A real person in chat never types «—»/«–»; they use a comma or a plain
  // hyphen. This runs on every generated line (belt-and-suspenders on top of
  // the prompt rule), so a stray dash can never reach the manager.
  out = deDash(out)

  // typos, word by word
  if (style.typoRate > 0) {
    out = out
      .split(/(\s+)/)
      .map((tok) => (/\s/.test(tok) || chance(1 - style.typoRate) ? tok : typoWord(tok)))
      .join('')
  }

  if (style.noPunctuation) {
    // drop most sentence punctuation; keep the odd question mark sometimes
    out = out.replace(/[.,;:!]+/g, '')
    if (chance(0.6)) out = out.replace(/\?+/g, '')
    out = out.replace(/\s+/g, ' ').trim()
  }

  if (style.lowercase) out = out.toLowerCase()

  if (style.emojiRate > 0 && chance(style.emojiRate)) {
    out = out + (chance(0.5) ? ' ' : '') + pickEmoji(style)
  }

  return out.slice(0, 500)
}

/**
 * Short human "impatience" poke sent when the manager has gone quiet for a
 * while — a real job-seeker double-texts «ну что там?», «алло», «?» instead of
 * waiting forever in silence. A pure LLM sim never does this, so the absence of
 * any follow-up nudge from the CLIENT side is itself a subtle bot tell. Tone is
 * picked from the persona: calm/polite people poke softly, hot-tempered ones
 * get irritated. Styled through applyStyle so it matches the persona's casing
 * and punctuation habits.
 */
const POKE_SOFT = [
  'ну что там?',
  'есть новости?',
  'алло, вы тут?',
  'ответите?',
  'ждууу ответ',
  'подскажете?',
  'так что по работе?',
  'ну как?',
]
const POKE_NEUTRAL = [
  'ау',
  '?',
  'ну?',
  'и?',
  'чё молчите',
  'долго ещё ждать',
  'вы там пропали?',
  'так что в итоге',
]
const POKE_HOT = [
  'долго ещё?',
  'вы там уснули?',
  'ну и где ответ',
  'че игнорите',
  'сколько можно ждать',
  'отвечать будете или нет',
  'ало я жду вообще-то',
]

export function impatientPoke(persona: SimPersona): string {
  const tone = persona.tone ?? 'mixed'
  const aggr = persona.style.profanity + persona.style.terseness
  const pool =
    tone === 'polite'
      ? POKE_SOFT
      : tone === 'rough' || aggr > 1.1
        ? POKE_HOT
        : POKE_NEUTRAL
  return applyStyle(pick(pool), persona.style)
}

/* ========================================================================= */
/*  Human "sбои" — accidental early sends and double-tap duplicates only.     */
/*  Applied at DELIVERY time (per bubble) so they read as separate messages.  */
/*  NB: self-corrections («*слово», autocorrect+fix) were removed — they were */
/*  a bot tell. See humanizeBubbles below.                                    */
/* ========================================================================= */


/** A standalone reaction "message" (emoji or a bracket-smiley), no words. */
export function reactionMessage(): string {
  return pick(REACTION_EMOJIS)
}

/**
 * Given the ordered bubbles the persona is about to send, occasionally weave in
 * believable human glitches, returning the NEW ordered list of bubbles.
 *
 * IMPORTANT — we deliberately DO NOT do "self-corrections" here anymore:
 *   • no «*слово» typo-then-correction bubbles, and
 *   • no fixed-list autocorrect ("сейчас"→"сейчак") with a standalone fix.
 * Both were dead giveaways: the «*слово» pattern screams "scripted bot", and the
 * autocorrect list reused the SAME handful of misspellings across every dialog,
 * so different "people" fixed the exact same words the exact same way. What's
 * left are glitches that are genuinely random and non-repetitive:
 *   • accidental early send — a short unfinished fragment fired before the full.
 *   • duplicate            — the same short bubble sent twice (double-tap send).
 *
 * Rates are deliberately low so glitches are seasoning, not noise. `typoRate`
 * scales how error-prone this persona is (polite personas ~never glitch).
 */
export function humanizeBubbles(bubbles: string[], style: SimStyle): string[] {
  if (bubbles.length === 0) return bubbles
  const glitchiness = Math.max(0, Math.min(1, style.typoRate ?? 0))
  if (glitchiness <= 0.02) return bubbles

  const out: string[] = []
  for (let idx = 0; idx < bubbles.length; idx++) {
    const bubble = bubbles[idx]
    const words = bubble.split(/\s+/).filter(Boolean)

    // --- accidental early send: fire the first 1-2 words as a stray, then the
    // full bubble (as if the send button was hit too soon). Only on longer ones.
    if (idx === 0 && words.length >= 5 && chance(glitchiness * 0.35)) {
      out.push(words.slice(0, randInt(1, 2)).join(' '))
    }

    out.push(bubble)

    // --- accidental duplicate (double-tap) on short bubbles ----------------
    if (words.length <= 4 && chance(glitchiness * 0.15)) {
      out.push(bubble)
    }
  }
  return out
}

/* ========================================================================= */
/*  Template fallback pools                                                  */
/*  Used only when the LLM is unavailable. Composed + mangled so even the    */
/*  fallback varies wildly and rarely repeats.                               */
/* ========================================================================= */


function fill(template: string, persona: SimPersona): string {
  return template.replace('{hook}', persona.jobHook)
}

export type TemplateKind = 'opener' | 'curious' | 'angry' | 'dismissive' | 'confused' | 'filler'

export function templateLine(kind: TemplateKind, persona: SimPersona): string {
  let pool: readonly string[]
  switch (kind) {
    case 'opener': pool = OPENERS; break
    case 'curious': pool = CURIOUS; break
    case 'angry': pool = ANGRY; break
    case 'dismissive': pool = DISMISSIVE; break
    case 'confused': pool = CONFUSED; break
    default: pool = FILLERS
  }

  let line = fill(pick(pool), persona)

  // Staple a second fragment on non-openers for variety — pick from a related
  // pool so it still reads coherently.
  if (kind !== 'opener' && chance(0.3)) {
    const secondPool =
      kind === 'angry'
        ? ANGRY
        : kind === 'confused'
          ? CONFUSED
          : kind === 'dismissive'
            ? DISMISSIVE
            : CURIOUS
    const second = fill(pick(secondPool), persona)
    if (normLoose(second) !== normLoose(line)) line = `${line} ${second}`
  }

  // Optional lead-in prefix (not on openers — they already greet).
  if (kind !== 'opener' && chance(0.3)) {
    line = `${pick(PREFIXES)} ${line}`
  }

  // Optional trailing tic.
  if (chance(0.2)) {
    line = `${line} ${pick(SUFFIXES)}`
  }

  return applyStyle(line, persona.style)
}

/** Loose normaliser used to avoid stapling two identical fragments together. */
function normLoose(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}
