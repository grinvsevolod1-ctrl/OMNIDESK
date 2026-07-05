/**
 * Autopilot rule matching — the shared, PURE core used by BOTH runtimes:
 *   - the Next.js panel (live-chat inbound in app/api/livechat/ingest)
 *   - the standalone worker (Telegram/WhatsApp inbound + no-response scheduler)
 *
 * This module MUST stay dependency-free: no `server-only`, no database, no
 * React, no `@/` path aliases, and NO relative imports either (the worker loads
 * it through tsx by relative path). Keep it pure functions + types only — the
 * small zoned-time helper below is intentionally self-contained for that reason.
 *
 * Working hours: a rule now carries its OWN schedule (RuleWorkingHours) which
 * the matcher evaluates here, so the condition works identically on every
 * channel. When a rule has no schedule the matcher falls back to the optional
 * channel-derived `insideWorkingHours` boolean the caller may pass in (used by
 * the legacy live-chat widget hours).
 */

export type AutopilotEvent = 'first_message' | 'any_message' | 'no_response'
export type KeywordMatch = 'any' | 'all'
export type WorkingHoursRequirement = 'any' | 'inside' | 'outside'

/**
 * A rule's OWN working-hours schedule. Self-contained (timezone + active
 * weekdays + open/close time) so a rule behaves identically across every
 * channel — Telegram/WhatsApp don't have a per-channel schedule like the
 * live-chat widget does, so without this the working-hours condition could
 * never be evaluated for messengers. Days are 0=Sun .. 6=Sat (JS getDay).
 */
export interface RuleWorkingHours {
  enabled: boolean
  tz: string
  startHour: number
  startMinute: number
  endHour: number
  endMinute: number
  days: number[]
}

/** Reply payload + condition filters for a rule (stored as jsonb). */
export interface AutopilotRuleConfig {
  /** Channel ids the rule applies to. Empty array = all of the manager's sources. */
  sources: string[]
  /** Keyword filter. Empty = no keyword condition. Matched case-insensitively. */
  keywords: string[]
  /** 'any' = at least one keyword present; 'all' = every keyword present. */
  keywordMatch: KeywordMatch
  /** Working-hours condition (any / inside / outside the schedule). */
  requireWorkingHours: WorkingHoursRequirement
  /**
   * The rule's own schedule used to evaluate `requireWorkingHours`. When null
   * (or disabled) the matcher falls back to the channel-provided
   * `insideWorkingHours` value, preserving the legacy live-chat behaviour.
   */
  workingHours: RuleWorkingHours | null
  /** For event 'no_response': minutes of manager silence before firing. */
  noResponseMinutes: number
  /** The message text auto-sent when the rule fires. */
  replyText: string
  /** Base human-like delay before sending (seconds) — anti-ban for messengers. */
  delaySec: number
  /** Fire at most once per conversation (always true for 'first_message'). */
  oncePerConversation: boolean
}

export interface AutopilotRule {
  id: string
  managerId: string
  name: string
  enabled: boolean
  sortOrder: number
  event: AutopilotEvent
  config: AutopilotRuleConfig
}

/** Describes the thing that just happened, fed to the matcher. */
export interface MatchInput {
  /**
   * Which pass is running:
   *  - 'inbound'     : a message just arrived (covers first_message/any_message)
   *  - 'no_response' : the scheduler tick (covers no_response only)
   */
  mode: 'inbound' | 'no_response'
  /** Inbound message text (for keyword matching). */
  text: string
  /** Channel/source id the message belongs to (for source filtering). */
  channelId: string
  /** Whether this is the very first inbound of the conversation. */
  isFirstMessage: boolean
  /**
   * Fallback "is it inside working hours" from the CHANNEL (live-chat widget).
   * Only consulted for rules that don't define their own schedule.
   *  - true / false : known
   *  - null         : unknown / not configured
   */
  insideWorkingHours: boolean | null
  /** Reference time for schedule evaluation. Defaults to now. */
  now?: Date
}

/** Defaults applied when coercing a raw jsonb blob into a safe config. */
export const DEFAULT_RULE_CONFIG: AutopilotRuleConfig = {
  sources: [],
  keywords: [],
  keywordMatch: 'any',
  requireWorkingHours: 'any',
  workingHours: null,
  noResponseMinutes: 5,
  replyText: '',
  delaySec: 4,
  oncePerConversation: true,
}

/** A sensible default schedule (Mon–Fri 09:00–18:00, Moscow) for the UI. */
export const DEFAULT_WORKING_HOURS: RuleWorkingHours = {
  enabled: true,
  tz: 'Europe/Moscow',
  startHour: 9,
  startMinute: 0,
  endHour: 18,
  endMinute: 0,
  days: [1, 2, 3, 4, 5],
}

const EVENTS: AutopilotEvent[] = ['first_message', 'any_message', 'no_response']

/** Coerce an unknown value into a safe RuleWorkingHours, or null when absent. */
export function normalizeWorkingHours(raw: unknown): RuleWorkingHours | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const clampInt = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) return fallback
    return Math.min(hi, Math.max(lo, Math.round(n)))
  }
  const days = Array.isArray(r.days)
    ? Array.from(
        new Set(
          r.days
            .map((d) => Number(d))
            .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
        ),
      ).sort((a, b) => a - b)
    : []
  return {
    enabled: r.enabled === true,
    tz: typeof r.tz === 'string' && r.tz.trim() ? r.tz.trim() : 'Europe/Moscow',
    startHour: clampInt(r.startHour, 0, 23, 9),
    startMinute: clampInt(r.startMinute, 0, 59, 0),
    endHour: clampInt(r.endHour, 0, 23, 18),
    endMinute: clampInt(r.endMinute, 0, 59, 0),
    days: days.length > 0 ? days : [1, 2, 3, 4, 5],
  }
}

/**
 * Day-of-week (0=Sun..6=Sat) + minutes-since-midnight for `now` in `tz`.
 * Self-contained copy of the live-chat off-hours math (lib/offhours.ts) so this
 * module keeps zero imports and runs in both the Next app and the tsx worker.
 */
function zonedDayAndMinutes(
  tz: string,
  now: Date,
): { dow: number; minutes: number } {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now)
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = fmt(tz || 'Europe/Moscow')
  } catch {
    parts = fmt('Europe/Moscow')
  }
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hour =
    Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  const minute = Number.parseInt(
    parts.find((p) => p.type === 'minute')?.value ?? '0',
    10,
  )
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  return { dow: map[weekday] ?? 0, minutes: hour * 60 + minute }
}

/**
 * True when `now` is INSIDE the rule's working window. Honors timezone, active
 * weekdays and the open/close times, including overnight windows (close before
 * open spilling past midnight).
 */
function insideSchedule(wh: RuleWorkingHours, now: Date): boolean {
  const { dow, minutes } = zonedDayAndMinutes(wh.tz, now)
  const start = wh.startHour * 60 + wh.startMinute
  const end = wh.endHour * 60 + wh.endMinute

  // Overnight window (e.g. 22:00 → 06:00): live across midnight.
  if (end <= start) {
    const liveToday = wh.days.includes(dow)
    const prevDow = (dow + 6) % 7
    const liveFromPrev = wh.days.includes(prevDow)
    const inEvening = minutes >= start && liveToday
    const inMorning = minutes < end && liveFromPrev
    return inEvening || inMorning
  }

  if (!wh.days.includes(dow)) return false
  return minutes >= start && minutes < end
}

/** Coerce an unknown jsonb value into a fully-populated, safe rule config. */
export function normalizeRuleConfig(raw: unknown): AutopilotRuleConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >
  const toStringArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => String(x ?? '').trim()).filter((x) => x.length > 0)
      : []
  const num = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    sources: toStringArray(r.sources),
    keywords: toStringArray(r.keywords),
    keywordMatch: r.keywordMatch === 'all' ? 'all' : 'any',
    requireWorkingHours:
      r.requireWorkingHours === 'inside' || r.requireWorkingHours === 'outside'
        ? r.requireWorkingHours
        : 'any',
    workingHours: normalizeWorkingHours(r.workingHours),
    noResponseMinutes: Math.max(
      1,
      Math.round(num(r.noResponseMinutes, DEFAULT_RULE_CONFIG.noResponseMinutes)),
    ),
    replyText: typeof r.replyText === 'string' ? r.replyText : '',
    delaySec: Math.min(
      60,
      Math.max(0, Math.round(num(r.delaySec, DEFAULT_RULE_CONFIG.delaySec))),
    ),
    oncePerConversation: r.oncePerConversation !== false,
  }
}

/** Coerce an unknown event string into a valid AutopilotEvent. */
export function normalizeEvent(raw: unknown): AutopilotEvent {
  return EVENTS.includes(raw as AutopilotEvent)
    ? (raw as AutopilotEvent)
    : 'first_message'
}

/** True if the inbound text satisfies the rule's keyword condition. */
function keywordsMatch(config: AutopilotRuleConfig, text: string): boolean {
  if (config.keywords.length === 0) return true
  const haystack = text.toLowerCase()
  const present = config.keywords.map((k) => haystack.includes(k.toLowerCase()))
  return config.keywordMatch === 'all'
    ? present.every(Boolean)
    : present.some(Boolean)
}

/** True if the working-hours condition is satisfied for this input. */
function workingHoursMatch(
  config: AutopilotRuleConfig,
  fallbackInside: boolean | null,
  now: Date,
): boolean {
  if (config.requireWorkingHours === 'any') return true
  // Prefer the rule's own schedule; fall back to the channel value otherwise.
  const inside: boolean | null =
    config.workingHours && config.workingHours.enabled
      ? insideSchedule(config.workingHours, now)
      : fallbackInside
  if (inside === null) return false // can't confirm → don't fire
  return config.requireWorkingHours === 'inside' ? inside : !inside
}

/** Whether the rule's dedupe rules require it to not have fired before. */
export function ruleRequiresDedupe(rule: AutopilotRule): boolean {
  return (
    rule.event === 'first_message' ||
    rule.event === 'no_response' ||
    rule.config.oncePerConversation === true
  )
}

/**
 * Evaluate a single rule against an input (event gating + all conditions).
 * Dedupe is checked separately by the caller via `ruleRequiresDedupe` + its
 * own fire-history lookup, so this stays free of async/DB concerns.
 */
export function ruleMatches(rule: AutopilotRule, input: MatchInput): boolean {
  if (!rule.enabled) return false

  // Event gating per pass.
  if (input.mode === 'no_response') {
    if (rule.event !== 'no_response') return false
  } else {
    if (rule.event === 'no_response') return false
    if (rule.event === 'first_message' && !input.isFirstMessage) return false
  }

  // Source filter ([] = all sources).
  if (
    rule.config.sources.length > 0 &&
    !rule.config.sources.includes(input.channelId)
  ) {
    return false
  }

  if (!keywordsMatch(rule.config, input.text)) return false
  if (
    !workingHoursMatch(
      rule.config,
      input.insideWorkingHours,
      input.now ?? new Date(),
    )
  ) {
    return false
  }

  return true
}

/**
 * Pick the first matching rule in priority order (sort_order asc, then created).
 * Caller is responsible for passing rules pre-sorted and for dedupe filtering.
 * Returns null when nothing matches.
 */
export function selectRule(
  rules: AutopilotRule[],
  input: MatchInput,
): AutopilotRule | null {
  for (const rule of rules) {
    if (ruleMatches(rule, input)) return rule
  }
  return null
}

/**
 * Compute a human-like send delay (ms) for anti-ban pacing on messengers.
 * Base delay + a bit of jitter + a small per-character typing component,
 * clamped so it never feels broken. Live-chat callers can ignore this and
 * send near-instantly (web has no ban risk).
 */
export function computeSendDelayMs(
  config: AutopilotRuleConfig,
  replyText: string,
  random: () => number = Math.random,
): number {
  const baseMs = Math.max(0, config.delaySec) * 1000
  const jitterMs = random() * 2500 // 0–2.5s jitter
  const typingMs = Math.min(6000, replyText.length * 45) // ~simulated typing
  const total = baseMs + jitterMs + typingMs
  // Clamp to a sane window so a rule can't stall the queue.
  return Math.min(20000, Math.max(800, Math.round(total)))
}
