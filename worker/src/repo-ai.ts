/* --------------------------------------------------------------------------
 * Worker-side AI/autopilot repository barrel. Split into focused domain
 * modules; every consumer keeps importing via `repo.*` / `repo-ai`:
 *
 *   repo-ai-config.ts     singleton settings (30s TTL cache), directives,
 *                         A/B experiment overlay, generation metrics
 *   repo-ai-context.ts    lessons, manual corrections, AI-led/handoff,
 *                         RAG retrieval, conversation memory, AI transcript
 *   repo-ai-autopilot.ts  autopilot rules, fire-dedup, anti-ban counting,
 *                         no-response scheduler feed, working hours
 *   repo-ai-logs.ts       micro-batched ai_logs writer
 * ------------------------------------------------------------------------ */
export * from './repo-ai-config.js'
export * from './repo-ai-context.js'
export * from './repo-ai-autopilot.js'
export * from './repo-ai-logs.js'
