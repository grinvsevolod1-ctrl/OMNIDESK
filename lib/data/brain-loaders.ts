import 'server-only'
/**
 * Next.js-side adapter: wires lib/data access into the shared brain-input
 * assembler (lib/ai/assemble-brain-input.ts). The worker has its own adapter
 * over its repo layer (worker/src/brain-loaders.ts) — keep them semantically
 * in sync.
 */

import type { BrainInputLoaders } from '../ai/assemble-brain-input'
import {
  getConversationAiMemory,
  getConversationHistoryForAi,
  listBrainLessons,
  listManualCorrectionRules,
  retrieveKnowledge,
} from './ai-assist'
import { directiveTexts } from './ai-directives'

export const dataBrainLoaders: BrainInputLoaders = {
  listLessons: listBrainLessons,
  listCorrections: listManualCorrectionRules,
  getHistory: getConversationHistoryForAi,
  getMemory: getConversationAiMemory,
  retrieveKnowledge,
  listDirectives: directiveTexts,
}
