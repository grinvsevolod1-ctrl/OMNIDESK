import 'server-only'
import { query } from '../db'

/**
 * Lead lifecycle SLA layer (migration 117): the chat-configured settings
 * singleton (archive + escalation thresholds) and the stuck-lead finder.
 * Follows the ai_followup_settings pattern — no hardcoded behaviour, the
 * admin tunes everything from the co-pilot chat.
 */

export interface LeadSlaSettings {
  /** Auto-archive final leads N days after the final confirm. 0 = off. */
  archiveAfterDays: number
  /** Escalate leads sitting in «Игнор» for N consecutive days. 0 = off. */
  ignoreAlertDays: number
  /** Escalate leads in «Ожидает выхода» for N consecutive days. 0 = off. */
  awaitingExitAlertDays: number
  updatedAt: string
}

interface SlaRow {
  archive_after_days: number | string
  ignore_alert_days: number | string
  awaiting_exit_alert_days: number | string
  updated_at: string | Date
}

function mapSettings(r: SlaRow): LeadSlaSettings {
  return {
    archiveAfterDays: Number(r.archive_after_days),
    ignoreAlertDays: Number(r.ignore_alert_days),
    awaitingExitAlertDays: Number(r.awaiting_exit_alert_days),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/** Read the singleton SLA settings, creating the row lazily if missing. */
export async function getLeadSlaSettings(): Promise<LeadSlaSettings> {
  const rows = await query<SlaRow>(
    `INSERT INTO lead_sla_settings (id) VALUES (true)
     ON CONFLICT (id) DO UPDATE SET id = true
     RETURNING archive_after_days, ignore_alert_days,
               awaiting_exit_alert_days, updated_at`,
  )
  return mapSettings(rows[0])
}

/** Partial update of the SLA settings (chat-driven). */
export async function updateLeadSlaSettings(patch: {
  archiveAfterDays?: number
  ignoreAlertDays?: number
  awaitingExitAlertDays?: number
}): Promise<LeadSlaSettings> {
  await getLeadSlaSettings()
  const clamp = (v: number | undefined) =>
    v === undefined ? null : Math.max(0, Math.min(365, Math.round(v)))
  const rows = await query<SlaRow>(
    `UPDATE lead_sla_settings
        SET archive_after_days       = COALESCE($1, archive_after_days),
            ignore_alert_days        = COALESCE($2, ignore_alert_days),
            awaiting_exit_alert_days = COALESCE($3, awaiting_exit_alert_days),
            updated_at = now()
      WHERE id = true
      RETURNING archive_after_days, ignore_alert_days,
                awaiting_exit_alert_days, updated_at`,
    [
      clamp(patch.archiveAfterDays),
      clamp(patch.ignoreAlertDays),
      clamp(patch.awaitingExitAlertDays),
    ],
  )
  return mapSettings(rows[0])
}

/** One lead stuck in a status beyond its SLA threshold. */
export interface SlaBreach {
  leadCardId: string
  fullName: string
  city: string
  status: 'ignore' | 'awaiting_exit'
  curatorId: string | null
  curatorName: string | null
  /** Days the lead has been in this status without interruption. */
  daysInStatus: number
  /** Configured threshold that was crossed. */
  thresholdDays: number
}

/**
 * Find active (non-archived, non-final) leads stuck in «Игнор» or
 * «Ожидает выхода» beyond the configured thresholds.
 *
 * «Days in status» = days since the start of the CURRENT uninterrupted run
 * of that status in lead_status_history (a confirm of a different status
 * resets the run). Leads with no history fall back to status_confirmed_at.
 */
export async function findSlaBreaches(
  settings: LeadSlaSettings,
): Promise<SlaBreach[]> {
  const targets: { status: 'ignore' | 'awaiting_exit'; days: number }[] = []
  if (settings.ignoreAlertDays > 0) {
    targets.push({ status: 'ignore', days: settings.ignoreAlertDays })
  }
  if (settings.awaitingExitAlertDays > 0) {
    targets.push({
      status: 'awaiting_exit',
      days: settings.awaitingExitAlertDays,
    })
  }
  if (targets.length === 0) return []

  const out: SlaBreach[] = []
  for (const t of targets) {
    const rows = await query<{
      lead_card_id: string
      full_name: string
      city: string
      curator_id: string | null
      curator_name: string | null
      days_in_status: string
    }>(
      `WITH last_other AS (
         SELECT h.lead_card_id, max(h.created_at) AS t
           FROM lead_status_history h
          WHERE h.reason = 'confirm' AND h.status IS DISTINCT FROM $1
          GROUP BY h.lead_card_id
       ),
       run_start AS (
         SELECT h.lead_card_id, min(h.created_at) AS since
           FROM lead_status_history h
           LEFT JOIN last_other lo ON lo.lead_card_id = h.lead_card_id
          WHERE h.reason = 'confirm' AND h.status = $1
            AND (lo.t IS NULL OR h.created_at > lo.t)
          GROUP BY h.lead_card_id
       )
       SELECT lc.id AS lead_card_id, lc.full_name, lc.city,
              lc.curator_id, c.name AS curator_name,
              floor(extract(epoch FROM (
                now() - COALESCE(rs.since, lc.status_confirmed_at, lc.updated_at)
              )) / 86400)::int AS days_in_status
         FROM lead_cards lc
         LEFT JOIN run_start rs ON rs.lead_card_id = lc.id
         LEFT JOIN managers c ON c.id = lc.curator_id
        WHERE lc.status = $1
          AND lc.archived_at IS NULL
          AND lc.transferred_at IS NOT NULL
          AND COALESCE(rs.since, lc.status_confirmed_at, lc.updated_at)
              < now() - make_interval(days => $2)
        ORDER BY days_in_status DESC
        LIMIT 100`,
      [t.status, t.days],
    )
    for (const r of rows) {
      out.push({
        leadCardId: r.lead_card_id,
        fullName: r.full_name ?? '',
        city: r.city ?? '',
        status: t.status,
        curatorId: r.curator_id,
        curatorName: r.curator_name,
        daysInStatus: Number(r.days_in_status ?? 0),
        thresholdDays: t.days,
      })
    }
  }
  return out.sort((a, b) => b.daysInStatus - a.daysInStatus)
}
