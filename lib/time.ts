/**
 * Time formatting helpers that ALWAYS render in Moscow time (MSK, UTC+3),
 * regardless of the viewer's browser/OS timezone.
 *
 * Why: timestamps are stored as correct UTC instants (timestamptz columns).
 * But `Date#toLocale*` without an explicit `timeZone` formats using the
 * viewer's local zone — so a manager whose machine sits in, say, UTC+7 would
 * see message times shifted hours ahead of the actual Moscow business time.
 * The whole product operates on MSK, so every user should see the same clock.
 *
 * MSK is a fixed UTC+3 offset (Russia dropped DST in 2014), which keeps the
 * day-bucketing math below stable year round.
 */
export const APP_TIME_ZONE = 'Europe/Moscow'

/** "HH:MM" in MSK. */
export function formatMskTime(value: string | number | Date): string {
  return new Date(value).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

/** "5 июн." (numeric day + short month) in MSK. */
export function formatMskDateShort(value: string | number | Date): string {
  return new Date(value).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    timeZone: APP_TIME_ZONE,
  })
}

/** "5 июн., 14:30" (short date + time) in MSK. */
export function formatMskDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

/**
 * Sortable "YYYY-MM-DD" key for the instant as seen in MSK. Use it to compare
 * whether two instants fall on the same Moscow calendar day.
 */
export function mskDayKey(value: string | number | Date): string {
  // en-CA gives ISO-ordered YYYY-MM-DD, which is both readable and sortable.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

/** MSK day key for "today" and "yesterday", for relative date labels. */
export function mskTodayKeys(): { today: string; yesterday: string } {
  const now = new Date()
  const today = mskDayKey(now)
  // Subtract 24h then re-key in MSK; safe because MSK has no DST.
  const yesterday = mskDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  return { today, yesterday }
}
