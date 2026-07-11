import type { ChannelType } from '@/lib/types'

/** Persona gender — keeps names / grammar internally consistent. */
export type SimGender = 'male' | 'female'

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
  style: SimStyle
}

/** Singleton control row (mirrors sim_settings). */
export interface SimSettings {
  enabled: boolean
  channelIds: string[]
  aggression: number
  maxThreads: number
  spawnMinSec: number
  spawnMaxSec: number
  replyMinSec: number
  replyMaxSec: number
  spawnedTotal: number
  repliesTotal: number
  startedAt: string | null
  updatedAt: string
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
