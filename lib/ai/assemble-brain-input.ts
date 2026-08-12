/**
 * Shared assembly of the manager brain's input context.
 *
 * The block "lessons + corrections + history + memory + knowledge + directives"
 * used to be duplicated across three runtimes (livechat autopilot, worker
 * autopilot, follow-up). Any change to the brain's input priorities had to be
 * synchronized by hand in all three places — this module is now the single
 * source of truth for WHAT is loaded, with WHICH limits, and HOW the RAG query
 * is chosen.
 *
 * Data access is injected: the Next.js side passes functions from lib/data,
 * the worker passes its repo functions. This module stays dependency-free so
 * both runtimes can import it (worker imports lib/* via relative .js paths).
 */

import type { BrainLesson, BrainMessage } from './brain/core'

/** Canonical limits — change here, applies to every runtime at once. */
export const BRAIN_INPUT_LIMITS = {
  lessons: 12,
  corrections: 60,
  history: 16,
  knowledge: 4,
} as const

export interface BrainInputLoaders {
  listLessons: (limit: number) => Promise<BrainLesson[]>
  listCorrections: (limit: number) => Promise<string[]>
  getHistory: (conversationId: string, limit: number) => Promise<BrainMessage[]>
  getMemory: (conversationId: string) => Promise<{ summary: string }>
  /** Vector search over the knowledge base. NEVER called with an empty query. */
  retrieveKnowledge: (queryText: string, k: number) => Promise<string>
  listDirectives: () => Promise<string[]>
}

/**
 * Conversation-independent context: identical for every dialog in a sweep.
 * Batch runtimes (follow-up) load this ONCE per sweep; single-message runtimes
 * just let assembleBrainInput fetch it inline.
 */
export interface SharedBrainContext {
  lessons: BrainLesson[]
  corrections: string[]
  directives: string[]
}

export async function loadSharedBrainContext(
  loaders: Pick<
    BrainInputLoaders,
    'listLessons' | 'listCorrections' | 'listDirectives'
  >,
): Promise<SharedBrainContext> {
  const [lessons, corrections, directives] = await Promise.all([
    loaders.listLessons(BRAIN_INPUT_LIMITS.lessons),
    loaders.listCorrections(BRAIN_INPUT_LIMITS.corrections),
    loaders.listDirectives(),
  ])
  return { lessons, corrections, directives }
}

export interface AssembledBrainInput extends SharedBrainContext {
  history: BrainMessage[]
  /** Distilled per-client memory summary ('' when none). */
  memory: string
  /** RAG facts for the current client message ('' when none / no query). */
  knowledge: string
}

/**
 * Load everything the brain needs for ONE conversation.
 *
 * RAG query priority: explicit `queryText` (the inbound message when the
 * caller has it) → the client's last message from history. An empty query is
 * never embedded: that would be a paid gateway call returning irrelevant
 * results, so knowledge degrades to '' instead.
 */
export async function assembleBrainInput(
  conversationId: string,
  loaders: BrainInputLoaders,
  opts?: {
    queryText?: string
    /** Pre-loaded sweep-level context (follow-up); loaded inline when absent. */
    shared?: SharedBrainContext
  },
): Promise<AssembledBrainInput> {
  const [shared, history, memory] = await Promise.all([
    opts?.shared ?? loadSharedBrainContext(loaders),
    loaders.getHistory(conversationId, BRAIN_INPUT_LIMITS.history),
    loaders.getMemory(conversationId),
  ])

  const queryText =
    opts?.queryText?.trim() ||
    [...history]
      .reverse()
      .find((m) => m.role === 'client')
      ?.body?.trim() ||
    ''
  const knowledge = queryText
    ? await loaders.retrieveKnowledge(queryText, BRAIN_INPUT_LIMITS.knowledge)
    : ''

  return {
    ...shared,
    history,
    memory: memory.summary ?? '',
    knowledge,
  }
}
