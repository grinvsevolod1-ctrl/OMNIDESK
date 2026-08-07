/**
 * Lead-card statistics with MSK date bucketing.
 *
 * Powers two views:
 * - the manager's «Мои лиды» page (only his cards, stats for today / a
 *   period / a single day, «Передан» filter);
 * - the admin date-based stats over all transferred leads.
 *
 * All day math happens IN SQL via `AT TIME ZONE 'Europe/Moscow'` so the
 * buckets always match the product's business day regardless of the server
 * or viewer timezone.
 */
import { isLeadStatus, type LeadStatus } from '../lead-status'
import { query } from '../db'
import {
  CARD_SELECT,
  toDateOnly,
  toLeadCard,
  type LeadCard,
  type LeadCardRow,
} from './lead-cards'

const MSK = 'Europe/Moscow'

/** Validated YYYY-MM-DD or null (never trust client input in SQL). */
export function safeDayKey(v: string | null | undefined): string | null {
  if (!v) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

export interface LeadCardStatsFilter {
  /** Scope to the manager who filled the card. */
  managerId?: string | null
  /** Scope to the curator currently holding the card. */
  curatorId?: string | null
  /** Inclusive MSK period; when omitted, defaults to the last 7 days. */
  from?: string | null
  to?: string | null
}

export interface LeadCardStats {
  from: string
  to: string
  /** Cards created within the period (MSK days). */
  created: number
  /** Cards whose transfer happened within the period. */
  transferred: number
  /** Cards created today (MSK), regardless of the selected period. */
  createdToday: number
  /** Cards transferred today (MSK), regardless of the selected period. */
  transferredToday: number
  /** Current status of cards created within the period. */
  byStatus: Partial<Record<LeadStatus, number>>
  /** Cards created in the period that have no confirmed status yet. */
  noStatus: number
  /** Per-day series over the period (inclusive, gaps filled with zeros). */
  byDay: { date: string; created: number; transferred: number }[]
}

function mskToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MSK,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

/** Clamp an arbitrary period to something sane (max 366 days). */
function normalizePeriod(filter: LeadCardStatsFilter): {
  from: string
  to: string
} {
  const today = mskToday()
  let to = safeDayKey(filter.to) ?? today
  let from = safeDayKey(filter.from) ?? shiftDay(to, -6)
  if (from > to) [from, to] = [to, from]
  if (shiftDay(from, 366) < to) from = shiftDay(to, -366)
  return { from, to }
}

export async function getLeadCardStats(
  filter: LeadCardStatsFilter = {},
): Promise<LeadCardStats> {
  const { from, to } = normalizePeriod(filter)
  const today = mskToday()

  // Each query gets its OWN parameter list: Postgres rejects a bind that
  // supplies more parameters than the statement references.
  const scopeValues: unknown[] = []
  const scopeConds: string[] = []
  if (filter.managerId) {
    scopeValues.push(filter.managerId)
    scopeConds.push('lc.manager_id')
  }
  if (filter.curatorId) {
    scopeValues.push(filter.curatorId)
    scopeConds.push('lc.curator_id')
  }
  /** Render the scope conditions with placeholders starting after `base`. */
  const scopeSqlFrom = (base: number): string =>
    scopeConds.map((col, i) => `${col} = $${base + i + 1}`).join(' AND ')

  const summaryParams = [from, to, today, ...scopeValues]
  const summaryScope = scopeConds.length ? `WHERE ${scopeSqlFrom(3)}` : ''
  const rangeParams = [from, to, ...scopeValues]
  const rangeScope = scopeConds.length ? scopeSqlFrom(2) : ''

  const [summaryRows, statusRows, dayRows] = await Promise.all([
    query<{
      created: string
      transferred: string
      created_today: string
      transferred_today: string
    }>(
      `SELECT
         count(*) FILTER (
           WHERE (lc.created_at AT TIME ZONE '${MSK}')::date BETWEEN $1::date AND $2::date
         ) AS created,
         count(*) FILTER (
           WHERE lc.transferred_at IS NOT NULL
             AND (lc.transferred_at AT TIME ZONE '${MSK}')::date BETWEEN $1::date AND $2::date
         ) AS transferred,
         count(*) FILTER (
           WHERE (lc.created_at AT TIME ZONE '${MSK}')::date = $3::date
         ) AS created_today,
         count(*) FILTER (
           WHERE lc.transferred_at IS NOT NULL
             AND (lc.transferred_at AT TIME ZONE '${MSK}')::date = $3::date
         ) AS transferred_today
       FROM lead_cards lc
       ${summaryScope}`,
      summaryParams,
    ),
    query<{ status: string | null; n: string }>(
      `SELECT lc.status, count(*)::int AS n
         FROM lead_cards lc
        WHERE ${rangeScope ? `${rangeScope} AND` : ''}
              (lc.created_at AT TIME ZONE '${MSK}')::date BETWEEN $1::date AND $2::date
        GROUP BY lc.status`,
      rangeParams,
    ),
    query<{ d: string | Date; created: string; transferred: string }>(
      `SELECT d.day AS d,
              count(lc.id) FILTER (
                WHERE (lc.created_at AT TIME ZONE '${MSK}')::date = d.day
              ) AS created,
              count(lc.id) FILTER (
                WHERE lc.transferred_at IS NOT NULL
                  AND (lc.transferred_at AT TIME ZONE '${MSK}')::date = d.day
              ) AS transferred
         FROM generate_series($1::date, $2::date, interval '1 day') AS d(day)
         LEFT JOIN lead_cards lc
           ON (
                (lc.created_at AT TIME ZONE '${MSK}')::date = d.day
                OR (lc.transferred_at IS NOT NULL
                    AND (lc.transferred_at AT TIME ZONE '${MSK}')::date = d.day)
              )
              ${rangeScope ? `AND ${rangeScope}` : ''}
        GROUP BY d.day
        ORDER BY d.day`,
      rangeParams,
    ),
  ])

  const byStatus: Partial<Record<LeadStatus, number>> = {}
  let noStatus = 0
  for (const r of statusRows) {
    if (isLeadStatus(r.status)) byStatus[r.status] = Number(r.n)
    else noStatus += Number(r.n)
  }

  const s = summaryRows[0]
  return {
    from,
    to,
    created: Number(s?.created ?? 0),
    transferred: Number(s?.transferred ?? 0),
    createdToday: Number(s?.created_today ?? 0),
    transferredToday: Number(s?.transferred_today ?? 0),
    byStatus,
    noStatus,
    byDay: dayRows.map((r) => ({
      date: toDateOnly(r.d) ?? '',
      created: Number(r.created ?? 0),
      transferred: Number(r.transferred ?? 0),
    })),
  }
}

/* ----------------------- Manager lead-card listing ----------------------- */

export type ManagerLeadFilterStatus =
  | LeadStatus
  | 'none'
  | 'transferred'
  | 'not_transferred'
  | null

export interface ManagerLeadsFilter {
  /** Inclusive MSK period applied to the card's creation day (or transfer day
   *  when status = 'transferred'). */
  from?: string | null
  to?: string | null
  status?: ManagerLeadFilterStatus
  limit?: number
  offset?: number
}

/** Карточка в списке менеджера + счётчик комментариев куратора для бейджа. */
export type ManagerLeadListItem = LeadCard & {
  /** Всего комментариев куратора в карточке (не считая своих). */
  curatorCommentCount: number
  /** ISO-время последнего комментария куратора — для метки «новое» на клиенте. */
  lastCuratorCommentAt: string | null
}

/** Manager: his own lead cards with period + status filters, newest first. */
export async function listLeadCardsForManager(
  managerId: string,
  filter: ManagerLeadsFilter = {},
): Promise<{ leads: ManagerLeadListItem[]; total: number }> {
  const from = safeDayKey(filter.from)
  const to = safeDayKey(filter.to)

  const conds: string[] = ['lc.manager_id = $1']
  const params: unknown[] = [managerId]

  // «Передан» filters by the transfer day; everything else by creation day.
  const dayExpr =
    filter.status === 'transferred'
      ? `(lc.transferred_at AT TIME ZONE '${MSK}')::date`
      : `(lc.created_at AT TIME ZONE '${MSK}')::date`

  if (from) {
    params.push(from)
    conds.push(`${dayExpr} >= $${params.length}::date`)
  }
  if (to) {
    params.push(to)
    conds.push(`${dayExpr} <= $${params.length}::date`)
  }

  if (filter.status === 'transferred') {
    conds.push('lc.transferred_at IS NOT NULL')
  } else if (filter.status === 'not_transferred') {
    conds.push('lc.transferred_at IS NULL')
  } else if (filter.status === 'none') {
    conds.push('lc.status IS NULL')
  } else if (isLeadStatus(filter.status)) {
    params.push(filter.status)
    conds.push(`lc.status = $${params.length}`)
  }

  const where = conds.join(' AND ')
  const totalRows = await query<{ n: string }>(
    `SELECT count(*)::int AS n FROM lead_cards lc WHERE ${where}`,
    params,
  )

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  params.push(limit, offset)

  // Комментарии куратора считаются латеральным подзапросом: бейдж «есть
  // ответ куратора» в списке без второго запроса с клиента.
  const rows = await query<
    LeadCardRow & { curator_comment_count: string; last_curator_comment_at: string | Date | null }
  >(
    `SELECT ${CARD_SELECT},
            COALESCE(cc.n, 0)::int AS curator_comment_count,
            cc.last_at              AS last_curator_comment_at
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, max(k.created_at) AS last_at
           FROM lead_card_comments k
          WHERE k.lead_card_id = lc.id
            AND k.author_id IS DISTINCT FROM lc.manager_id
       ) cc ON true
      WHERE ${where}
      ORDER BY lc.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )

  return {
    leads: rows.map((r) => ({
      ...toLeadCard(r),
      curatorCommentCount: Number(r.curator_comment_count ?? 0),
      lastCuratorCommentAt: r.last_curator_comment_at
        ? new Date(r.last_curator_comment_at).toISOString()
        : null,
    })),
    total: Number(totalRows[0]?.n ?? 0),
  }
}
