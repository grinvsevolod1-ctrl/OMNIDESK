/**
 * Analytics for the AI co-pilot console: performance rollups over the AI
 * manager's REAL work, so an admin can ask "how did we do this week?" in chat
 * and get honest numbers.
 *
 * ISOLATION INVARIANT: every query here filters `is_simulated = false`. The
 * simulator and the god panel must never be reachable — not even indirectly —
 * from the co-pilot surface, so simulated dialogs are excluded from every
 * co-pilot-facing aggregate. (This is deliberately STRICTER than the training
 * harvest, which treats sim dialogs as real; the co-pilot must only ever report
 * on genuine client outcomes.)
 */
import { query } from '../db'
import { effectiveStatusSql } from './shared'
import type { LeadStatus } from '../types'

/** A performance snapshot over a trailing window of real AI-led dialogs. */
export interface AiPerformanceSummary {
  /** Size of the window in days (as requested). */
  windowDays: number
  /** Real dialogs the AI led that were created in the window. */
  totalDialogs: number
  /** Dialogs where the AI handed off to a human (lost control / escalation). */
  handoffs: number
  /** Dialogs marked as qualified/liquid leads. */
  liquid: number
  /** Dialogs marked not-liquid. */
  notLiquid: number
  /** Dialogs transferred onward. */
  transferred: number
  /** Contacts that only ever wrote once and got no status progression. */
  unsubscribed: number
  /** Count by effective lead status, for a full breakdown. */
  byStatus: Record<LeadStatus, number>
  /** Percentage of dialogs that reached "liquid" (0..100, one decimal). */
  liquidRatePct: number
  /** Percentage of dialogs that ended in a human handoff (0..100). */
  handoffRatePct: number
}

/**
 * Roll up the AI manager's real outcomes over the last `days` days. Only counts
 * conversations that are AI-enrolled and NOT simulated, so the numbers reflect
 * genuine client work. `days` is clamped to 1..365.
 */
export async function getAiPerformanceSummary(
  days = 7,
): Promise<AiPerformanceSummary> {
  const windowDays = Math.max(1, Math.min(365, Math.round(days)))

  const rows = await query<{ status: string; n: string | number }>(
    `SELECT ${effectiveStatusSql('c')} AS status, COUNT(*) AS n
       FROM conversations c
      WHERE c.is_simulated = false
        AND c.ai_enrolled = true
        AND c.created_at >= now() - ($1 || ' days')::interval
      GROUP BY ${effectiveStatusSql('c')}`,
    [String(windowDays)],
  )

  const byStatus: Record<LeadStatus, number> = {
    unsubscribed: 0,
    handoff: 0,
    liquid: 0,
    not_liquid: 0,
    transferred: 0,
  }
  for (const r of rows) {
    const key = r.status as LeadStatus
    if (key in byStatus) byStatus[key] = Number(r.n)
  }

  const totalDialogs = Object.values(byStatus).reduce((a, b) => a + b, 0)
  const pct = (n: number) =>
    totalDialogs === 0 ? 0 : Math.round((n / totalDialogs) * 1000) / 10

  return {
    windowDays,
    totalDialogs,
    handoffs: byStatus.handoff,
    liquid: byStatus.liquid,
    notLiquid: byStatus.not_liquid,
    transferred: byStatus.transferred,
    unsubscribed: byStatus.unsubscribed,
    byStatus,
    liquidRatePct: pct(byStatus.liquid),
    handoffRatePct: pct(byStatus.handoff),
  }
}

/** A real dialog where the AI likely underperformed, with its transcript. */
export interface WeakDialog {
  conversationId: string
  status: LeadStatus
  /** "Клиент: …\nМенеджер: …" transcript, oldest→newest. */
  transcript: string
}

/**
 * Find REAL (never simulated) AI-led dialogs that ended badly — handed off to a
 * human or marked not-liquid — so the co-pilot can study what went wrong and
 * propose lessons. Only two-way dialogs (both sides spoke) are useful. Newest
 * first, capped. Honors the isolation invariant: `is_simulated = false`.
 */
export async function listUnderperformingDialogs(
  limit = 8,
): Promise<WeakDialog[]> {
  const cap = Math.max(1, Math.min(25, Math.round(limit)))
  const convs = await query<{ id: string; status: string }>(
    `SELECT c.id, ${effectiveStatusSql('c')} AS status
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
                       AND m.deleted_at IS NULL AND m.body <> ''
      WHERE c.is_simulated = false
        AND c.ai_enrolled = true
        AND ${effectiveStatusSql('c')} IN ('handoff', 'not_liquid')
      GROUP BY c.id, c.status, c.last_message_at
     HAVING COUNT(*) FILTER (WHERE m.direction = 'in')  > 0
        AND COUNT(*) FILTER (WHERE m.direction = 'out') > 0
      ORDER BY c.last_message_at DESC
      LIMIT $1`,
    [cap],
  )

  const out: WeakDialog[] = []
  for (const conv of convs) {
    const rows = await query<{ direction: 'in' | 'out'; body: string }>(
      `SELECT direction, body FROM messages
        WHERE conversation_id = $1 AND deleted_at IS NULL AND body <> ''
        ORDER BY created_at ASC
        LIMIT 40`,
      [conv.id],
    )
    if (rows.length < 2) continue
    const transcript = rows
      .map(
        (r) =>
          `${r.direction === 'in' ? 'Клиент' : 'Менеджер'}: ${r.body.trim()}`,
      )
      .join('\n')
    out.push({
      conversationId: conv.id,
      status: conv.status as LeadStatus,
      transcript,
    })
  }
  return out
}
