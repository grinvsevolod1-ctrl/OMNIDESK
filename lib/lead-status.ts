/**
 * Curator lead statuses — single source of truth for labels, colours and checks.
 */
import { APP_TIME_ZONE, mskDayKey } from '@/lib/time'

export const LEAD_STATUSES = [
  'awaiting_exit',
  'training',
  'working',
  'temporarily_off',
  'no_contact',
  'refused',
  'ignore',
  'left',
] as const

export type LeadStatus = (typeof LEAD_STATUSES)[number]

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  awaiting_exit: 'Ожидает выхода',
  training: 'Обучение',
  working: 'В работе',
  temporarily_off: 'Временно не работает',
  no_contact: 'Не связался',
  refused: 'Отказался',
  ignore: 'Игнор',
  left: 'Кинул',
}

/** Tailwind-friendly tone classes for badges (bg + text). */
export const LEAD_STATUS_TONE: Record<
  LeadStatus,
  { bg: string; text: string; dot: string }
> = {
  awaiting_exit: {
    bg: 'bg-sky-500/15',
    text: 'text-sky-700 dark:text-sky-400',
    dot: 'bg-sky-500',
  },
  training: {
    bg: 'bg-violet-500/15',
    text: 'text-violet-700 dark:text-violet-400',
    dot: 'bg-violet-500',
  },
  working: {
    bg: 'bg-emerald-500/15',
    text: 'text-emerald-700 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  temporarily_off: {
    bg: 'bg-amber-500/15',
    text: 'text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  no_contact: {
    bg: 'bg-orange-500/15',
    text: 'text-orange-700 dark:text-orange-400',
    dot: 'bg-orange-500',
  },
  refused: {
    bg: 'bg-rose-500/15',
    text: 'text-rose-700 dark:text-rose-400',
    dot: 'bg-rose-500',
  },
  ignore: {
    bg: 'bg-slate-500/15',
    text: 'text-slate-700 dark:text-slate-400',
    dot: 'bg-slate-500',
  },
  left: {
    bg: 'bg-red-500/15',
    text: 'text-red-700 dark:text-red-400',
    dot: 'bg-red-500',
  },
}

export function isLeadStatus(value: string | null | undefined): value is LeadStatus {
  return !!value && (LEAD_STATUSES as readonly string[]).includes(value)
}

/**
 * Final statuses end the lead's active lifecycle: the person refused or
 * disappeared for good. Final leads are exempt from the daily confirmation
 * gate and are auto-archived after the configured number of days.
 */
export const FINAL_LEAD_STATUSES = ['refused', 'left'] as const satisfies
  readonly LeadStatus[]

export function isFinalLeadStatus(
  value: string | null | undefined,
): value is (typeof FINAL_LEAD_STATUSES)[number] {
  return (
    !!value && (FINAL_LEAD_STATUSES as readonly string[]).includes(value)
  )
}

export function leadStatusLabel(value: string | null | undefined): string {
  if (isLeadStatus(value)) return LEAD_STATUS_LABELS[value]
  return 'Не указан'
}

/** Hour (0–23) in Europe/Moscow when the daily status deadline fires. */
export const DAILY_STATUS_DEADLINE_HOUR = 10

/** Minimum length of the required comment when confirming a status. */
export const STATUS_COMMENT_MIN_LEN = 30

/** True once the Moscow clock is at/after the daily deadline hour. */
export function isPastDailyDeadline(now: Date = new Date()): boolean {
  const hourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIME_ZONE,
    hour: 'numeric',
    hour12: false,
  }).format(now)
  // en-GB can yield "24" at midnight in some engines — normalise.
  const hour = Number(hourStr) % 24
  return hour >= DAILY_STATUS_DEADLINE_HOUR
}

/**
 * Does this lead still need today's status confirmation?
 * - Before 10:00 MSK: only leads that have NEVER been confirmed.
 * - At/after 10:00 MSK: any lead whose confirmation is not for today's MSK date.
 */
export function needsDailyStatusUpdate(
  statusConfirmedDate: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const today = mskDayKey(now)
  if (!statusConfirmedDate) return true
  if (!isPastDailyDeadline(now)) return false
  return statusConfirmedDate !== today
}

/**
 * Lifecycle-aware daily gate check: final leads (refused/left) never require
 * a daily confirmation again — their story is over. Use this instead of raw
 * needsDailyStatusUpdate() wherever the lead's status is available.
 */
export function leadNeedsDailyStatus(
  lead: {
    status: string | null
    statusConfirmedDate: string | null | undefined
  },
  now: Date = new Date(),
): boolean {
  if (isFinalLeadStatus(lead.status)) return false
  return needsDailyStatusUpdate(lead.statusConfirmedDate, now)
}
