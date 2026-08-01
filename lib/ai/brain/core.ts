/**
 * Shared foundation of the manager AI "brain": types, gateway constants and
 * the small pure helpers every other brain module builds on.
 *
 * DEPENDENCY RULES (apply to every file in lib/ai/brain/):
 *   - no `server-only`, no database, no React, no `@/` path aliases, and NOT
 *     the `ai` SDK (the worker doesn't install it);
 *   - brain modules may import EACH OTHER via relative paths with the `.js`
 *     extension (the worker consumes them through tsx/ESM, same as
 *     lib/autopilot/match.js) — but nothing outside lib/ai/brain/.
 * The brain talks to the Vercel AI Gateway directly over its OpenAI-compatible
 * REST endpoint via `fetch`, so it runs identically under Next.js and under
 * tsx in the worker.
 *
 * The knowledge base is shared across all managers (product decision): a single
 * business persona, a distilled playbook, and a corpus of correction "lessons".
 */

/**
 * Optional diagnostics sink. The brain stays dependency-free (no DB, no `@/`),
 * so instead of writing logs itself it emits structured events through this
 * plain callback. Each runtime injects its own writer: the panel persists to
 * the `ai_logs` table, the worker does the same via its repo. Passing nothing
 * keeps the brain silent (its original behaviour).
 */
export type BrainLog = (e: {
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  message: string
  meta?: Record<string, unknown>
}) => void

/** A single chat turn as the model sees it. */
export interface BrainMessage {
  role: 'client' | 'manager'
  body: string
}

/** One admin correction used to steer future replies (lightweight RAG). */
export interface BrainLesson {
  situation: string
  corrected: string
  note?: string
}

/** Everything the generator needs to produce one in-character manager reply. */
export interface ManagerBrainInput {
  /** Business context written by the admin (what we do, how we talk). */
  persona: string
  /** Tone/register hint, e.g. "professional", "friendly". */
  tone: string
  /** Distilled bullet-point rules the admin has trained. */
  playbook: string[]
  /**
   * The chat-driven MANDATE: durable, hand-managed rules the admin dictated to
   * the co-pilot in plain language (stored in ai_directives, ordered). Injected
   * at the highest priority — right under the scenario — so "the admin said it
   * in chat and that's how it is". Optional for older callers.
   */
  directives?: string[]
  /** Recent correction lessons (most relevant first). */
  lessons: BrainLesson[]
  /**
   * Strict, hand-written corrections the admin taught on specific messages.
   * These are ALWAYS injected and take absolute priority — the AI must never
   * repeat a mistake it was corrected on. Optional for older callers.
   */
  corrections?: string[]
  /**
   * Durable memory about THIS client (name, city, budget, objections,
   * agreements, next step) distilled by extractClientMemory and stored per
   * conversation. Injected verbatim so the AI keeps context on long dialogs
   * without replaying the whole transcript. Optional for older callers.
   */
  memory?: string
  /**
   * Relevant facts retrieved from the RAG knowledge base (prices, terms, FAQ)
   * for the current client message. Injected as ground-truth so the AI quotes
   * real numbers instead of hallucinating. The runtime does the vector search;
   * the brain just receives the assembled text. Optional for older callers.
   */
  knowledge?: string
  /**
   * Persuasion intensity 0..3, resolved by the caller from admin settings:
   *   0 gentle · 1 steady · 2 assertive (default) · 3 relentless.
   * Scales how hard the sales brain pushes toward the goal. Undefined → 2, so
   * older callers keep today's behaviour exactly. Always bounded by the ethical
   * floor baked into the prompt regardless of level.
   */
  aggressiveness?: number
  /** Conversation so far, oldest → newest. */
  history: BrainMessage[]
}

export const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions'

// gpt-4.1 gives the most coherent, context-aware replies to real clients — the
// priority for customer-facing messages. Override with MANAGER_AI_MODEL, or at
// runtime via BrainConfig.model (admin panel setting) which takes precedence.
export const MODEL = process.env.MANAGER_AI_MODEL || 'openai/gpt-4.1'
export const DEFAULT_TEMPERATURE = 0.7
export const DEFAULT_MAX_TOKENS = 400

/**
 * Optional per-call model configuration, resolved by the CALLER from the admin
 * settings (keeps this module dependency-free — it never reads the DB itself).
 * Any field left undefined/empty falls back to the built-in defaults, so old
 * callers that pass nothing behave exactly as before.
 */
export interface BrainConfig {
  model?: string | null
  temperature?: number | null
  maxTokens?: number | null
  /**
   * When true, run one extra self-critique pass over the draft reply and
   * silently repair it if it contradicts the scenario/known facts, leaks an
   * AI tell, or breaks tone. Costs one more gateway call; off by default.
   */
  selfCritique?: boolean | null
}

export function resolveModel(config?: BrainConfig): string {
  const m = config?.model?.trim()
  return m || MODEL
}

/** Structured metric emitted once per gateway call via the BrainLog sink. */
export interface BrainMetric {
  purpose: 'reply' | 'assess'
  model: string
  outcome: 'ok' | 'empty' | 'refused' | 'http_error' | 'exception'
  latencyMs: number
  promptTokens?: number
  completionTokens?: number
}

/** Reply generation is only possible when the gateway key is present. */
export function isBrainConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY)
}

/** Shape of the gateway's OpenAI-compatible chat-completions response. */
export interface GatewayChoice {
  message?: { content?: string | null }
}
export interface GatewayResponse {
  choices?: GatewayChoice[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

const REFUSAL = [
  'i cannot',
  'i can’t',
  "i can't",
  'as an ai',
  'как ии',
  'как языковая модель',
  'языковая модель',
  'я не могу помочь',
  'я — искусственный интеллект',
  'я искусственный интеллект',
  'я бот',
  'я — бот',
  'я чат-бот',
  'я чатбот',
  'я нейросеть',
  'я — нейросеть',
  'я виртуальный ассистент',
  'я ассистент',
  'я программа',
  'я всего лишь',
  'я не человек',
]

export function looksLikeRefusal(text: string): boolean {
  const t = text.toLowerCase()
  return REFUSAL.some((r) => t.includes(r))
}

/**
 * Scrub the tell-tale signs of AI text so a client can never spot the bot.
 * Applied to EVERY generated reply before it's sent. Purely mechanical and
 * language-safe: it only touches punctuation/markdown artefacts, never rewrites
 * meaning.
 *
 *  - Long em/en dashes («—», «–», «―», «‒», «−») are the #1 AI giveaway in
 *    Russian chat. Real people type a comma or a plain hyphen. We convert a
 *    dash used as a clause break (" — ") into a comma, and a stray standalone
 *    dash into a plain hyphen.
 *  - Markdown emphasis (**bold**, *italic*, `code`, ###, leading "- "/"* "
 *    bullets) never appears in a human chat message, so we strip it.
 *  - Collapse the doubled spaces / stray whitespace left behind.
 */
export function humanizeReply(text: string): string {
  let t = text

  // Strip markdown emphasis and headings that a human would never type.
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
  t = t.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2') // *italic*
  t = t.replace(/`([^`]+)`/g, '$1') // `code`
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '') // ### headings
  // Leading list bullets ("- ", "* ", "• ", "1. ") at the start of a line.
  t = t.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')

  // Dashes: the biggest AI tell. Handle the "clause break" form first
  // (space-dash-space → comma-space), then any remaining dash → plain hyphen.
  t = t.replace(/\s*[—–―‒−]\s+/g, ', ') // " — " used as a pause
  t = t.replace(/[—–―‒−]/g, '-') // any leftover long dash → hyphen

  // Tidy: collapse spaces, fix space-before-punctuation, trim.
  t = t.replace(/[ \t]{2,}/g, ' ')
  t = t.replace(/\s+([,.!?;:])/g, '$1')
  t = t.replace(/,\s*,/g, ',')
  t = t.replace(/^[\s,;:]+/, '')

  return t.trim()
}

/** Human hint for common AI Gateway HTTP failures (shown in the logs tab). */
export function gatewayStatusHint(status: number): string {
  if (status === 401 || status === 403)
    return ' — ключ AI Gateway недействителен или не имеет доступа (проверьте AI_GATEWAY_API_KEY).'
  if (status === 402)
    return ' — на аккаунте AI Gateway закончились средства/кредиты (пополните баланс).'
  if (status === 429)
    return ' — превышен лимит запросов (rate limit), попробуйте позже.'
  if (status >= 500) return ' — временная ошибка на стороне AI Gateway.'
  return ''
}
