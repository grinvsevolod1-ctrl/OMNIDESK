/**
 * Working-hours logic for the website live chat.
 *
 * Each site defines its own working hours (timezone, active weekdays and
 * open/close times). The chat is "live" only inside that window; outside it the
 * widget switches to an off-hours state that offers messenger links instead of
 * an interactive chat.
 *
 * All time math is anchored to the site's configured timezone (falling back to
 * Europe/Moscow for an invalid zone), so the switch is deterministic regardless
 * of the server's or visitor's own timezone.
 */

/** Day-of-week (0=Sun..6=Sat) and minutes-since-midnight in a given timezone. */
function zonedDayAndMinutes(
  tz: string,
  now: Date,
): { dow: number; minutes: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'Europe/Moscow',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now)
  } catch {
    // Invalid timezone — fall back to Moscow so the switch stays deterministic.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Moscow',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now)
  }
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  const minute = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const dow = map[weekday] ?? 0
  return { dow, minutes: hour * 60 + minute }
}

/** Minimal shape needed to decide off-hours; matches WidgetWorkingHours. */
export interface WorkingHoursLike {
  enabled: boolean
  tz: string
  startHour: number
  startMinute: number
  endHour: number
  endMinute: number
  days: number[]
}

/**
 * Per-site off-hours decision. Honors the timezone, active weekdays and the
 * open/close times, including overnight windows (end before start). When the
 * config is disabled the chat is always considered live.
 */
export function isOffHoursFor(
  wh: WorkingHoursLike,
  now: Date = new Date(),
): boolean {
  if (!wh || !wh.enabled) return false
  const { dow, minutes } = zonedDayAndMinutes(wh.tz, now)
  const start = wh.startHour * 60 + wh.startMinute
  const end = wh.endHour * 60 + wh.endMinute

  // Overnight window (e.g. 22:00 → 06:00): live across midnight.
  if (end <= start) {
    const liveToday = wh.days.includes(dow)
    // Previous day spilling past midnight counts toward the early-morning slot.
    const prevDow = (dow + 6) % 7
    const liveFromPrev = wh.days.includes(prevDow)
    const inEvening = minutes >= start && liveToday
    const inMorning = minutes < end && liveFromPrev
    return !(inEvening || inMorning)
  }

  if (!wh.days.includes(dow)) return true
  return minutes < start || minutes >= end
}

/**
 * Normalize a raw WhatsApp phone/number entry into a wa.me deep link. Admins
 * enter a phone number (any format); we keep only digits and build the link.
 * Returns null when there aren't enough digits to be a real number.
 */
export function whatsappLinkFromPhone(raw: string): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length < 7) return null
  return `https://wa.me/${digits}`
}

/** Lightweight validation for an admin-entered Telegram link. */
export function isValidTelegramLink(raw: string): boolean {
  const v = String(raw ?? '').trim()
  if (!v) return false
  try {
    const url = new URL(v)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    return /(^|\.)t\.me$/.test(url.hostname) || /(^|\.)telegram\.me$/.test(url.hostname)
  } catch {
    return false
  }
}
