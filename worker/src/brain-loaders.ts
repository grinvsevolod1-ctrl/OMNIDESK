/**
 * Worker-side adapter: wires the worker's repo layer into the shared
 * brain-input assembler (lib/ai/assemble-brain-input.ts). Mirrors the Next.js
 * adapter in lib/data/brain-loaders.ts — keep them semantically in sync.
 *
 * Directives are NOT loaded here by default: the worker's AI config already
 * carries them through a 30-second TTL cache (see repo-ai.ts getAiConfig), so
 * callers pass them via `directivesFromConfig` to avoid a duplicate query per
 * inbound message.
 */

import type { BrainInputLoaders } from '../../lib/ai/assemble-brain-input.js'
import * as repo from './repo.js'

export function workerBrainLoaders(
  directivesFromConfig: string[],
): BrainInputLoaders {
  return {
    listLessons: (limit) => repo.listAiLessons(limit),
    listCorrections: (limit) => repo.listManualCorrectionRules(limit),
    getHistory: (conversationId, limit) =>
      repo.getConversationHistoryForAi(conversationId, limit),
    getMemory: (conversationId) =>
      repo.getConversationAiMemory(conversationId),
    retrieveKnowledge: (queryText, k) => repo.retrieveKnowledge(queryText, k),
    listDirectives: async () => directivesFromConfig,
  }
}
