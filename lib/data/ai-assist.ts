import 'server-only'

/* --------------------------------------------------------------------------
 * AI-assist data layer — DOMAIN BARREL.
 *
 * The original monolith was split into focused sibling modules; callers keep
 * importing everything from this module so no import paths change:
 *
 *   ai-assist-settings.ts    singleton settings + playbook
 *   ai-assist-metrics.ts     generation metrics / A/B stats
 *   ai-assist-lessons.ts     training lessons (admin + brain shapes)
 *   ai-assist-history.ts     conversation history + durable AI memory
 *   ai-assist-enrollment.ts  enrollment / pause / AI→human handoffs
 *   ai-assist-knowledge.ts   RAG knowledge base (embeddings + retrieval)
 *   ai-assist-training.ts    training corpus (pre-existing sibling)
 *   ai-assist-corrections.ts corrections/review (pre-existing sibling)
 *   ai-assist-shared.ts      shared helpers/types (pre-existing sibling)
 * ------------------------------------------------------------------------ */

export { mediaPlaceholder } from './ai-assist-shared'
export type { TrainingSample } from './ai-assist-shared'
export * from './ai-assist-training'
export * from './ai-assist-corrections'
export * from './ai-assist-settings'
export * from './ai-assist-metrics'
export * from './ai-assist-lessons'
export * from './ai-assist-history'
export * from './ai-assist-enrollment'
export * from './ai-assist-knowledge'
