import type { ChannelType } from '@/lib/types'

/** Persona gender — keeps names / grammar internally consistent. */
export type SimGender = 'male' | 'female'

/**
 * Overall register the simulated clients write in. This is the strong lever
 * for how "clients" sound, on top of the aggression slider:
 *   polite  — «Здравствуйте», на «вы», грамотно, без мата
 *   neutral — обычный разговорный тон, по-человечески, без грубости
 *   rough   — развязно/панибратски, «привет», «чё», мат по настроению
 *   mixed   — как раньше: случайный разброс от вежливых до грубых
 */
export type SimTone = 'polite' | 'neutral' | 'rough' | 'mixed'

/**
 * Thread state machine. All states except `done` are "active"
 * (state <> 'done') and are picked up by the due-scheduler.
 *
 *   opening  — just created, opening line sent, waiting for the manager
 *   chatting — active back-and-forth
 *   ignoring — went quiet mid-chat (short pause; may resurface soon or die)
 *   later    — explicitly said "занят, отвечу позже" — will come back in hours
 *   sleeping — dormant for the night / weekend — resumes when "awake"
 *   vanished — dropped off for a long stretch (a day+) — may resurface later
 *   done     — conversation is over (see `outcome` for why)
 */
export type SimState =
  | 'opening'
  | 'chatting'
  | 'ignoring'
  | 'later'
  | 'sleeping'
  | 'vanished'
  | 'done'

/**
 * Why a dialogue ended (set only when state = 'done'). Surfaced in the panel /
 * logs so the operator can see each simulated client's "fate".
 *   ended      — natural close / agreed / nothing more to say
 *   left       — переписался и ушёл (lost interest, wandered off politely)
 *   competitor — ушёл к конкуренту («уже нашёл другого / там дают больше»)
 *   ghosted    — просто пропал и не вернулся (reaped after long silence)
 *   angry      — вспылил и хлопнул дверью (blew up and ended it)
 */
export type SimOutcome = 'ended' | 'left' | 'competitor' | 'ghosted' | 'angry'

/**
 * Per-persona writing fingerprint. Every value is rolled once at spawn so a
 * given "person" writes consistently across the whole conversation — one guy
 * always drops punctuation, another always TYPES IN CAPS when angry, etc.
 */
export interface SimStyle {
  /** Writes everything in lower case. */
  lowercase: boolean
  /** Drops most punctuation (no periods/commas, maybe no question marks). */
  noPunctuation: boolean
  /** 0..1 — probability of introducing a typo per word. */
  typoRate: number
  /** 0..1 — how much this persona swears. */
  profanity: number
  /** 0..1 — higher = shorter, more clipped messages. */
  terseness: number
  /** 0..1 — asks naive/confused questions, misreads the manager. */
  dumbness: number
  /** 0..1 — chance of dropping an emoji/"))))" at the end. */
  emojiRate: number
  /**
   * Which "laugh/emoji" register this persona is consistent in. Real people
   * rarely mix bracket-laughs «)))» with picture emoji at random — they lean one
   * way. Locking it per-persona removes that tell. Optional for legacy rows
   * (treated as 'mixed' when absent, i.e. the old behaviour).
   */
  emojiStyle?: 'brackets' | 'emoji' | 'mixed'
}

/**
 * A behavioural archetype — the single strongest lever for "this feels like a
 * different person every time". Each archetype bundles a goal, a default
 * attitude and a way of reacting that the generator leans on heavily. All 16
 * are defined in content.ts. Optional on the persona for legacy rows.
 */
export interface SimArchetype {
  /** Stable id, e.g. 'skeptic', 'bargainer', 'desperate'. */
  id: string
  /** Short human label, e.g. «Скептик». */
  label: string
  /** One-line description of how this person behaves, fed to the LLM. */
  brief: string
  /** Nudges applied on top of rolled style (all optional, -1..1 deltas). */
  moodBias?: number
  patienceBias?: number
  talkativeness?: number
}

/**
 * A slice of life the persona carries into the chat. Purely flavour that makes
 * the LLM write concrete, grounded messages instead of generic ones.
 */
export interface SimBackstory {
  /** Their real day-job / situation, e.g. «работает на стройке вахтой». */
  occupation: string
  /** Why they're looking — the motivation, e.g. «нужны деньги на кредит». */
  motivation: string
  /** Region/city flavour, e.g. «Краснодар». */
  region: string
  /** A concrete life detail they might drop, e.g. «двое детей». */
  detail: string
}

/**
 * Per-persona stable speech fingerprint — rolled ONCE at spawn, persisted in
 * sim_threads.persona, used in every subsequent generate call. Gives the model a
 * concrete character "voice" that stays consistent across all turns of this one
 * dialogue so the operator never reads two messages and thinks "same bot".
 *
 * All fields are optional so legacy persona rows without a fingerprint still work.
 */
export interface SpeechFingerprint {
  /**
   * This persona's personal connector word or phrase — injected into every
   * prompt so they use it instead of the generic AI fill-words.
   * Example: «короче», «ну вот», «слушай», «типа», «я к чему».
   */
  connector?: string
  /**
   * One persistent grammar or punctuation quirk that makes them unique.
   * Example: «никогда не ставит вопросительный знак», «пишет «и» вместо «и »
   * перед согласной», «раздельно пишет "не" почти всегда».
   */
  grammarQuirk?: string
  /**
   * One personal typing habit, e.g. «всегда пишет "чё" вместо "что"»,
   * «сокращает "спасибо" → "спс"», «пишет числа словами».
   */
  typingHabit?: string
  /**
   * Characteristic sentence-ending pattern, e.g. «заканчивает фразы многоточием»,
   * «ставит два восклицательных знака», «обрывает без знака»,
   * «иногда добавляет "ну"».
   */
  sentenceEnding?: string
  /**
   * One topic or personal detail they tend to circle back to,
   * e.g. «постоянно упоминает что двое детей», «вспоминает кредит».
   * Injected as a light nudge, not a mandate.
   */
  personalDetail?: string
}

/** A fully-formed fake client. */
export interface SimPersona {
  name: string
  handle: string
  /** Public @username (telegram/vk), without the leading '@'. */
  username?: string
  gender: SimGender
  channelType: ChannelType
  age: number
  /** Mood/temperament label used to steer the LLM + template picks. */
  temper: string
  /** The "job" they believe they found on the site (varied per persona). */
  jobHook: string
  /** Register this persona writes in (defaults to 'mixed' for legacy rows). */
  tone?: SimTone
  style: SimStyle
  /** Behavioural archetype (optional for legacy rows). */
  archetype?: SimArchetype
  /** Grounding backstory (optional for legacy rows). */
  backstory?: SimBackstory
  /**
   * Verbal tics this persona sprinkles in — filler words, catchphrases, verbal
   * habits, e.g. «короче», «ну это самое», «братан». Rolled once at spawn.
   */
  quirks?: string[]
  /**
   * Free-form character traits shown to the LLM, e.g. «недоверчивый»,
   * «торопится», «любит поторговаться». A richer replacement for the single
   * `temper` label (which is kept for backward compat + template picks).
   */
  traits?: string[]
  /**
   * The concrete outcome this client is really after in the chat (their private
   * agenda), e.g. «понять реальный заработок и решиться, если это не развод»
   * or «вытрясти все детали и уйти, ничего не заплатив». Drives the scenario
   * ARC: the client pushes toward this goal and advances stage to stage instead
   * of looping. Rolled once at spawn. Optional for legacy rows (no arc then).
   */
  goal?: string
  /**
   * Stable speech fingerprint — rolled once at spawn so every message from this
   * persona carries the same consistent "voice" (connector word, grammar quirk,
   * typing habit, sentence ending, recurring detail). Optional for legacy rows.
   */
  speechFingerprint?: SpeechFingerprint
}

/**
 * Operator-editable persona name banks. All arrays are optional — missing
 * entries fall back to the hardcoded defaults in content/data.ts.
 */
export interface SimPersonaConfig {
  maleFirstNames?: string[]
  femaleFirstNames?: string[]
  lastNames?: string[]
  tempers?: string[]
  occupations?: string[]
  motivations?: string[]
  lifeDetails?: string[]
  quirks?: string[]
  goals?: string[]
  /** Archetype overrides: provide the full list to replace all 16 defaults. */
  archetypes?: Array<{
    id: string
    label: string
    brief: string
    moodBias: number
    patienceBias: number
    talkativeness: number
  }>
  openerTemplates?: string[]
  emojiPictures?: string[]
}

/**
 * Full content config stored in sim_settings.content_config.
 * Combines web-form lead config (opener) with persona factory pools.
 * NULL on any sub-field means "use the hardcoded default".
 */
export interface SimContentConfig {
  /** Name shown in the opening message, e.g. "Thunders Group". */
  siteName?: string
  /** Vacancy list for the web-form opener. */
  vacancies?: Array<{ title: string; salary: string }>
  /** City pool for the opener. */
  cities?: string[]
  /** Work-schedule type labels: "Удалённо", "Полный день", "Сменный график". */
  scheduleTypes?: string[]
  matchPctMin?: number
  matchPctMax?: number
  /** Persona name / trait pools. */
  persona?: SimPersonaConfig
}

/** Singleton control row (mirrors sim_settings). */
export interface SimSettings {
  enabled: boolean
  channelIds: string[]
  /**
   * The ONE human-facing knob: how many brand-new dialogues the bots open per
   * day. Everything else (concurrency, spawn jitter, reply delays, per-persona
   * tone/aggression) is derived autonomously by the engine.
   */
  dialogsPerDay: number
  /**
   * INDEPENDENT cap on how many dialogues may be live at the same moment.
   * Decoupled from `dialogsPerDay` so the operator can run a big simultaneous
   * crowd (up to ~100+) regardless of the daily arrival rate. Defaults to 100.
   */
  maxConcurrent: number
  /**
   * Legacy tunables — kept for backward compatibility with the DB columns, but
   * no longer surfaced in the UI or used by the engine (each persona now rolls
   * its own tone/aggression, and pacing is derived from `dialogsPerDay`).
   */
  aggression: number
  tone: SimTone
  maxThreads: number
  spawnMinSec: number
  spawnMaxSec: number
  replyMinSec: number
  replyMaxSec: number
  spawnedTotal: number
  repliesTotal: number
  startedAt: string | null
  updatedAt: string
  /**
   * Operator-edited content pools (site name, vacancies, cities, schedule
   * types, persona banks). NULL means "use hardcoded defaults". Persisted as
   * JSONB in sim_settings.content_config (migration 080).
   */
  contentConfig: SimContentConfig | null

  /* ----------------------------- campaign ------------------------------- */
  /**
   * Campaign mode: a bounded burst that opens `campaignTarget` brand-new
   * dialogues, paced to finish by `campaignEndsAt`. While active it overrides
   * the steady `dialogsPerDay` cadence. Auto-stops when the target is reached
   * or the window elapses.
   */
  campaignActive: boolean
  /** How many new dialogues the active campaign should open in total. */
  campaignTarget: number
  /** ISO time the campaign window closes, or null when no campaign. */
  campaignEndsAt: string | null
  /** ISO time the campaign started, or null when no campaign. */
  campaignStartedAt: string | null
  /** `spawnedTotal` when the campaign began, so progress = spawnedTotal - baseline. */
  campaignBaseline: number
}

/** Live snapshot for the god-panel dashboard. */
export interface SimStatus extends SimSettings {
  /** Engine actually running in this process (leader). */
  running: boolean
  /** Active (non-done) bot threads right now. */
  activeThreads: number
  /** Threads in each state. */
  byState: Record<SimState, number>
  /** Finished dialogues grouped by outcome (the client's "fate"). */
  byOutcome: Record<SimOutcome, number>
  /** Whether AI Gateway generation is available. */
  aiConfigured: boolean
}

/** One row of sim_threads plus its persona. */
export interface SimThreadRow {
  conversationId: string
  channelId: string
  persona: SimPersona
  state: SimState
  turns: number
  lastSeenOut: string | null
  nextRunAt: string | null
  /** Why it ended (only when state = 'done'). */
  outcome: SimOutcome | null
  /** How many times the backlog sweep has poked the manager without progress. */
  nudgeAttempts: number
  /**
   * Operator has stepped into THIS dialogue from the god console, so the
   * simulator is detached from it (the scheduler skips it) until re-enabled.
   * Other threads are unaffected. Defaults to false on legacy rows.
   */
  paused: boolean
}
