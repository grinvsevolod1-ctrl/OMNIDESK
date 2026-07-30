/**
 * Client-sim transcript: flat oldest-to-newest message list for one simulated conversation.
 */

import {
  query,
} from '@/lib/db'
import {
  clearGlobalLineMemory,
} from '../line-memory'

export interface SimTranscriptLine {
  direction: 'in' | 'out'
  body: string
}

export async function getTranscript(
  conversationId: string,
  limit = 16,
): Promise<SimTranscriptLine[]> {
  const rows = await query<{ direction: 'in' | 'out'; body: string }>(
    `SELECT direction, body
       FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, limit],
  )
  return rows.reverse().map((r) => ({ direction: r.direction, body: r.body }))
}

/* --------------------------------------------------------------------------
 * Re-exports for backward compatibility. These concerns were split into
 * focused sibling modules; callers continue importing them from the store.
 * ------------------------------------------------------------------------ */
export {
  rememberGlobalLine,
  getGlobalRecentLines,
  clearGlobalLineMemory,
  getGlobalRecentOpeners,
} from './line-memory'
export type {
  SimCorrection,
  SimReviewMessage,
  CorpusDialogue,
} from './learning'
export {
  addSimCorrection,
  listSimCorrections,
  listSimCorrectionRules,
  deleteSimCorrection,
  countSimCorrections,
  getSimDialogForReview,
  sampleRealClientLines,
  sampleRealDialogues,
  saveLearnedProfile,
  getLearnedPointersCached,
  invalidateSimCorrectionsCache,
  getSimCorrectionRulesCached,
} from './learning'
