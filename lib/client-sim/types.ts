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
 * Thread state machine:
 *   opening  — just created, opening line sent, waiting for the manager
 *   chatting — active back-and-forth
 *   ignoring — the persona decided to go quiet (may resurface or die)
 *   done     — conversation is over (blew up / lost interest / "agreed")
 */
export type SimState = 'opening' | 'chatting' | 'ignoring' | 'done'

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
}

/**
 * Distilled knowledge the AI extracted from real conversations when the admin
 * pressed "Изучить все диалоги". Doubles as the report shown in the panel AND
 * as extra guidance injected into the generator's prompt.
 */
export interface LearnedProfile {
  /** ISO timestamp of the analysis. */
  learnedAt: string
  /** How many real dialogues were sampled. */
  dialogueCount: number
  /** How many real messages were read. */
  messageCount: number
  /** Channel types present in the sample. */
  channels: string[]
  /** 2–4 sentence plain-language summary of what was understood. */
  summary: string
  /** Observations about tone / emotion of real clients. */
  toneNotes: string[]
  /** What clients typically ask about or bring up. */
  commonTopics: string[]
  /** Concrete, actionable writing pointers for imitating the real voice. */
  stylePointers: string[]
  /** A handful of representative real phrases (anonymised, short). */
  samplePhrases: string[]
}

/** Singleton control row (mirrors sim_settings). */
export interface SimSettings {
  enabled: boolean
  channelIds: string[]
  aggression: number
  /** Register the simulated clients write in. */
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
  /** Latest AI-learned style profile, or null if never run. */
  learnedProfile: LearnedProfile | null
}

/** Live snapshot for the god-panel dashboard. */
export interface SimStatus extends SimSettings {
  /** Engine actually running in this process (leader). */
  running: boolean
  /** Active (non-done) bot threads right now. */
  activeThreads: number
  /** Threads in each state. */
  byState: Record<SimState, number>
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
}
