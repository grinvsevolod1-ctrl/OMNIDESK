/**
 * Manager AI "brain" — the shared, PURE reply generator used by BOTH runtimes:
 *   - the Next.js panel (admin trainer + live-chat auto-lead)
 *   - the standalone worker (Telegram/WhatsApp auto-lead)
 *
 * This is the stable entry point; the implementation lives in lib/ai/brain/
 * (core, prompt, reply, assess, media, embeddings, training). Import from HERE
 * — the panel via `@/lib/ai/manager-brain`, the worker via
 * `../../lib/ai/manager-brain.js` — so both runtimes share one public surface.
 *
 * Dependency rules for everything under lib/ai/brain/ are documented in
 * lib/ai/brain/core.ts: no `server-only`, no database, no React, no `@/` path
 * aliases, no `ai` SDK — raw `fetch` against the Vercel AI Gateway only, so it
 * runs identically under Next.js and under tsx in the worker.
 */

export {
  isBrainConfigured,
  humanizeReply,
  type BrainLog,
  type BrainMessage,
  type BrainLesson,
  type ManagerBrainInput,
  type BrainConfig,
  type BrainMetric,
} from './brain/core'

export {
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  embedText,
  toVectorLiteral,
} from './brain/embeddings'

export {
  understandableMediaKind,
  describeImage,
  transcribeAudio,
  understandMedia,
  type UnderstandableMedia,
} from './brain/media'

export { generateManagerReply } from './brain/reply'

export {
  clientShowsReadinessSignal,
  assessLeadReady,
  extractClientMemory,
  detectEscalation,
  type EscalationVerdict,
} from './brain/assess'

export {
  distillPlaybookFromDialogs,
  distillPlaybook,
  generateSalesScenario,
  analyzeDialogsForLessons,
  analyzeLossPatterns,
  type GeneratedScenario,
  type ProposedLesson,
  type LossPattern,
} from './brain/training'
