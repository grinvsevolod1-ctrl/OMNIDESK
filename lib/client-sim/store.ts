/**
 * Data-access layer for the client-simulator ("god-mode" synthetic dialogues).
 *
 * This file is a thin barrel. The SQL lives in focused per-domain modules under
 * ./store/ (settings / campaign / threads / conversations / transcript), with
 * the shared row shapes, runtime column probes and row→domain mappers in
 * ./store/internal. Everything is re-exported so existing imports from
 * '@/lib/client-sim/store' keep working unchanged.
 */

export * from './store/settings'
export * from './store/campaign'
export * from './store/threads'
export * from './store/conversations'
export * from './store/transcript'

/* --------------------------------------------------------------------------
 * Backward-compatibility re-exports. These concerns live in their own sibling
 * modules; callers have long imported them from the store, so keep them here.
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
