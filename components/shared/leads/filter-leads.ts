import type { LeadCard } from '@/lib/data/lead-cards'

/**
 * Shared client-side status + free-text filtering used by every role's leads
 * view. Each role has few leads (hundreds), so filtering happens on the client
 * for instant feedback. Sorting is intentionally NOT here — it differs per role
 * (curator sorts by status rank + daily-deadline urgency, head sorts by date),
 * so each view sorts the returned slice itself.
 *
 * `statusFilter`: '' = all, 'none' = only leads without a status, otherwise an
 * exact status match. `search` matches (case-insensitive) any of full name,
 * phone, telegram username, city, or vacancy.
 */
export function filterLeadsByStatusAndSearch(
  source: LeadCard[],
  statusFilter: string,
  search: string,
): LeadCard[] {
  const q = search.trim().toLowerCase()
  let out = source
  if (statusFilter === 'none') out = out.filter((l) => !l.status)
  else if (statusFilter) out = out.filter((l) => l.status === statusFilter)
  if (q) {
    out = out.filter((l) =>
      [l.fullName, l.phone, l.telegramUsername, l.city, l.vacancy]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    )
  }
  return out
}
