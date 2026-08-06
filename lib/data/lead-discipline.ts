import { isLeadStatus, type LeadStatus } from '@/lib/lead-status'
import { mskDayKey } from '@/lib/time'
import { query } from '../db'

/**
 * Curator daily-status discipline: the gate counter, today's snapshot,
 * 30-day history and overdue lists. Split out of lead-cards.ts (which holds
 * the card CRUD/transfer logic) — import either module directly, or through
 * lead-cards.ts which re-exports this one for existing call sites.
 */

/**
 * Count of leads a curator must still confirm.
 * Mirrors needsDailyStatusUpdate():
 * - before the deadline only never-confirmed leads count;
 * - past the deadline any lead not confirmed for today counts.
 * Final leads (refused/left) and archived leads are exempt (migration 117).
 */
export async function countLeadsNeedingStatus(
  curatorId: string,
  todayMsk: string,
  pastDeadline: boolean,
): Promise<number> {
  const rows = await query<{ n: string }>(
    pastDeadline
      ? `SELECT count(*)::int AS n
           FROM lead_cards
          WHERE curator_id = $1
            AND transferred_at IS NOT NULL
            AND archived_at IS NULL
            AND (status IS NULL OR status NOT IN ('refused', 'left'))
            AND (status_confirmed_date IS NULL OR status_confirmed_date < $2::date)`
      : `SELECT count(*)::int AS n
           FROM lead_cards
          WHERE curator_id = $1
            AND transferred_at IS NOT NULL
            AND archived_at IS NULL
            AND (status IS NULL OR status NOT IN ('refused', 'left'))
            AND status_confirmed_date IS NULL
            AND $2::date IS NOT NULL`,
    [curatorId, todayMsk],
  )
  return Number(rows[0]?.n ?? 0)
}

export interface CuratorDiscipline {
  curatorId: string
  curatorName: string
  city: string | null
  totalLeads: number
  confirmedToday: number
  /** Leads that still need today's confirmation (deadline-agnostic count). */
  pendingToday: number
  statusCounts: Partial<Record<LeadStatus, number>>
}

/** Admin: per-curator discipline snapshot for today (MSK). */
export async function getCuratorDiscipline(): Promise<CuratorDiscipline[]> {
  const today = mskDayKey(new Date())
  const rows = await query<{
    curator_id: string
    curator_name: string
    city: string | null
    total_leads: string
    confirmed_today: string
    pending_today: string
    status: string | null
    status_count: string
  }>(
    // GROUP BY returns one row per curator+status instead of one row per
    // curator+lead (the old window-function version) — with 1000 leads this
    // is ~6 rows per curator over the wire instead of ~1000.
    `SELECT c.id AS curator_id, c.name AS curator_name, c.city,
            sum(count(lc.id)) OVER (PARTITION BY c.id) AS total_leads,
            sum(count(lc.id) FILTER (WHERE lc.status_confirmed_date = $1::date))
              OVER (PARTITION BY c.id) AS confirmed_today,
            -- Final leads (refused/left) are exempt from the daily gate.
            sum(count(lc.id) FILTER (
              WHERE (lc.status IS NULL OR lc.status NOT IN ('refused', 'left'))
                AND (lc.status_confirmed_date IS NULL
                     OR lc.status_confirmed_date < $1::date)
            )) OVER (PARTITION BY c.id) AS pending_today,
            lc.status,
            count(lc.id) AS status_count
       FROM managers c
       LEFT JOIN lead_cards lc
         ON lc.curator_id = c.id
        AND lc.transferred_at IS NOT NULL
        AND lc.archived_at IS NULL
      WHERE c.role = 'curator' AND c.status = 'active'
      GROUP BY c.id, c.name, c.city, lc.status`,
    [today],
  )

  const byId = new Map<string, CuratorDiscipline>()
  for (const r of rows) {
    let cur = byId.get(r.curator_id)
    if (!cur) {
      cur = {
        curatorId: r.curator_id,
        curatorName: r.curator_name,
        city: r.city,
        totalLeads: Number(r.total_leads ?? 0),
        confirmedToday: Number(r.confirmed_today ?? 0),
        pendingToday: Number(r.pending_today ?? 0),
        statusCounts: {},
      }
      byId.set(r.curator_id, cur)
    }
    if (isLeadStatus(r.status)) {
      cur.statusCounts[r.status] = Number(r.status_count ?? 0)
    }
  }
  return [...byId.values()].sort((a, b) =>
    a.curatorName.localeCompare(b.curatorName, 'ru'),
  )
}

/** Historical discipline over the last N days, from lead_status_history. */
export interface CuratorDisciplineHistory {
  curatorId: string
  /** Distinct MSK days with at least one status confirmation. */
  activeDays: number
  /** Total 'confirm' events in the window. */
  totalConfirms: number
  /** Confirms made before the 10:00 MSK deadline. */
  onTimeConfirms: number
  /** onTimeConfirms / totalConfirms, in percent (0 when no confirms). */
  onTimeRatePct: number
}

/**
 * Admin: per-curator discipline over the last `days` days (default 30).
 * Counts only 'confirm' events (transfer resets are not the curator's doing).
 * «Вовремя» = the confirmation happened before 10:00 MSK that day.
 */
export async function getCuratorDisciplineHistory(
  days = 30,
): Promise<Map<string, CuratorDisciplineHistory>> {
  const rows = await query<{
    curator_id: string
    active_days: string
    total_confirms: string
    on_time: string
  }>(
    `SELECT h.curator_id,
            count(DISTINCT (h.created_at AT TIME ZONE 'Europe/Moscow')::date) AS active_days,
            count(*) AS total_confirms,
            count(*) FILTER (
              WHERE extract(hour FROM h.created_at AT TIME ZONE 'Europe/Moscow') < 10
            ) AS on_time
       FROM lead_status_history h
      WHERE h.reason = 'confirm'
        AND h.curator_id IS NOT NULL
        AND h.created_at >= now() - make_interval(days => $1)
      GROUP BY h.curator_id`,
    [days],
  )
  const map = new Map<string, CuratorDisciplineHistory>()
  for (const r of rows) {
    const total = Number(r.total_confirms ?? 0)
    const onTime = Number(r.on_time ?? 0)
    map.set(r.curator_id, {
      curatorId: r.curator_id,
      activeDays: Number(r.active_days ?? 0),
      totalConfirms: total,
      onTimeConfirms: onTime,
      onTimeRatePct: total > 0 ? Math.round((onTime / total) * 100) : 0,
    })
  }
  return map
}

/** Curators (id + name) who still have unconfirmed statuses for today. */
export async function listCuratorsWithOverdueStatuses(): Promise<
  { curatorId: string; curatorName: string; pending: number }[]
> {
  const today = mskDayKey(new Date())
  const rows = await query<{
    curator_id: string
    curator_name: string
    pending: string
  }>(
    `SELECT c.id AS curator_id, c.name AS curator_name, count(lc.id)::int AS pending
       FROM managers c
       JOIN lead_cards lc
         ON lc.curator_id = c.id
        AND lc.transferred_at IS NOT NULL
        AND lc.archived_at IS NULL
        AND (lc.status IS NULL OR lc.status NOT IN ('refused', 'left'))
        AND (lc.status_confirmed_date IS NULL OR lc.status_confirmed_date < $1::date)
      WHERE c.role = 'curator' AND c.status = 'active'
      GROUP BY c.id, c.name`,
    [today],
  )
  return rows.map((r) => ({
    curatorId: r.curator_id,
    curatorName: r.curator_name,
    pending: Number(r.pending ?? 0),
  }))
}
