/**
 * Analytics for the AI co-pilot console: performance rollups over the AI
 * manager's work, so an admin can ask "how did we do this week?" in chat and get
 * honest numbers.
 *
 * These aggregates cover ALL AI-led conversations. Dialogs are just dialogs —
 * the AI, analytics, lessons and follow-up all treat every conversation the same
 * way, exactly like the rest of the app. There is no special-casing here.
 */
import { query } from '../db'
import { effectiveStatusSql } from './shared'
import type { LeadStatus } from '../types'

/** A performance snapshot over a trailing window of real AI-led dialogs. */
export interface AiPerformanceSummary {
  /** Size of the window in days (as requested). */
  windowDays: number
  /** Dialogs the AI led that were created in the window. */
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
 * Roll up the AI manager's outcomes over the last `days` days across all
 * AI-enrolled conversations. `days` is clamped to 1..365.
 */
export async function getAiPerformanceSummary(
  days = 7,
): Promise<AiPerformanceSummary> {
  const windowDays = Math.max(1, Math.min(365, Math.round(days)))

  const rows = await query<{ status: string; n: string | number }>(
    `SELECT ${effectiveStatusSql('c')} AS status, COUNT(*) AS n
       FROM conversations c
      WHERE c.ai_enrolled = true
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

/**
 * Two consecutive windows of the same length, so the co-pilot can answer
 * "стало лучше после вчерашних правок?" with honest deltas instead of a
 * single snapshot.
 */
export interface AiPerformanceTrend {
  windowDays: number
  current: AiPerformanceSummary
  previous: AiPerformanceSummary
  /** current minus previous, for the headline metrics. */
  delta: {
    totalDialogs: number
    liquid: number
    handoffs: number
    liquidRatePct: number
    handoffRatePct: number
  }
}

/** Same rollup as getAiPerformanceSummary but over an offset window. */
async function summaryForWindow(
  windowDays: number,
  offsetDays: number,
): Promise<AiPerformanceSummary> {
  const rows = await query<{ status: string; n: string | number }>(
    `SELECT ${effectiveStatusSql('c')} AS status, COUNT(*) AS n
       FROM conversations c
      WHERE c.ai_enrolled = true
        AND c.created_at >= now() - (($1 + $2) || ' days')::interval
        AND c.created_at <  now() - ($2 || ' days')::interval
      GROUP BY ${effectiveStatusSql('c')}`,
    [String(windowDays), String(offsetDays)],
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

/**
 * Compare the trailing `days` window against the window immediately before it
 * (same length). `days` is clamped to 1..180 so both windows fit in a year.
 */
export async function getAiPerformanceTrend(
  days = 7,
): Promise<AiPerformanceTrend> {
  const windowDays = Math.max(1, Math.min(180, Math.round(days)))
  const [current, previous] = await Promise.all([
    summaryForWindow(windowDays, 0),
    summaryForWindow(windowDays, windowDays),
  ])
  const r1 = (n: number) => Math.round(n * 10) / 10
  return {
    windowDays,
    current,
    previous,
    delta: {
      totalDialogs: current.totalDialogs - previous.totalDialogs,
      liquid: current.liquid - previous.liquid,
      handoffs: current.handoffs - previous.handoffs,
      liquidRatePct: r1(current.liquidRatePct - previous.liquidRatePct),
      handoffRatePct: r1(current.handoffRatePct - previous.handoffRatePct),
    },
  }
}

/** Full readable transcript of one conversation, with dialog metadata. */
export interface DialogTranscript {
  conversationId: string
  contactName: string
  channelType: string
  status: LeadStatus
  aiEnrolled: boolean
  lastMessageAt: string | null
  messageCount: number
  /** True when the transcript was cut at the cap (oldest messages dropped). */
  truncated: boolean
  /** "Клиент: …" / "Менеджер: …" lines, oldest→newest, each with a timestamp. */
  lines: Array<{ from: 'Клиент' | 'Менеджер'; body: string; at: string }>
}

const TRANSCRIPT_CAP = 60

/**
 * Read one dialog end-to-end so the co-pilot can quote and analyze the real
 * conversation ("почему этот клиент слился?"). Honors hidden contacts the same
 * way the dialog lists do. Returns null when the conversation does not exist.
 */
export async function getDialogTranscript(
  conversationId: string,
): Promise<DialogTranscript | null> {
  const meta = await query<{
    id: string
    status: string
    ai_enrolled: boolean
    last_message_at: string | null
    channel_type: string
    contact_name: string
    contact_name_hidden: boolean
  }>(
    `SELECT c.id, ${effectiveStatusSql('c')} AS status, c.ai_enrolled,
            c.last_message_at, c.channel_type,
            c.contact_name, c.contact_name_hidden
       FROM conversations c
      WHERE c.id = $1`,
    [conversationId],
  )
  if (meta.length === 0) return null
  const m = meta[0]

  const [{ n }] = await query<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM messages
      WHERE conversation_id = $1 AND deleted_at IS NULL AND body <> ''`,
    [conversationId],
  )
  const messageCount = Number(n)

  // Keep the NEWEST cap-full of messages (the endgame matters most for
  // "почему слился"), then flip back to chronological order.
  const rows = await query<{
    direction: 'in' | 'out'
    body: string
    created_at: string
  }>(
    `SELECT direction, body, created_at FROM (
        SELECT direction, body, created_at FROM messages
         WHERE conversation_id = $1 AND deleted_at IS NULL AND body <> ''
         ORDER BY created_at DESC
         LIMIT $2
     ) t ORDER BY created_at ASC`,
    [conversationId, TRANSCRIPT_CAP],
  )

  return {
    conversationId: m.id,
    contactName: m.contact_name_hidden ? 'Скрыт' : m.contact_name,
    channelType: m.channel_type,
    status: m.status as LeadStatus,
    aiEnrolled: m.ai_enrolled,
    lastMessageAt: m.last_message_at,
    messageCount,
    truncated: messageCount > rows.length,
    lines: rows.map((r) => ({
      from: r.direction === 'in' ? ('Клиент' as const) : ('Менеджер' as const),
      body: r.body.trim().slice(0, 1500),
      at: r.created_at,
    })),
  }
}

/** A dialog where the AI likely underperformed, with its transcript. */
export interface WeakDialog {
  conversationId: string
  status: LeadStatus
  /** "Клиент: …\nМенеджер: …" transcript, oldest→newest. */
  transcript: string
}

/**
 * Find AI-led dialogs that ended badly — handed off to a human or marked
 * not-liquid — so the co-pilot can study what went wrong and propose lessons.
 * Only two-way dialogs (both sides spoke) are useful. Newest first, capped.
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
      WHERE c.ai_enrolled = true
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

/**
 * LOST dialogs within a period, with transcripts — the raw material for the
 * batch post-mortem (analyzeLossPatterns). Broader than
 * listUnderperformingDialogs: includes unsubscribed too, and is period-scoped
 * so «разбери проигрыши за месяц» means exactly that. Two-way dialogs only.
 */
export async function listLostDialogs(
  days = 30,
  limit = 15,
): Promise<WeakDialog[]> {
  const windowDays = Math.max(1, Math.min(180, Math.round(days)))
  const cap = Math.max(1, Math.min(20, Math.round(limit)))
  const convs = await query<{ id: string; status: string }>(
    `SELECT c.id, ${effectiveStatusSql('c')} AS status
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
                       AND m.deleted_at IS NULL AND m.body <> ''
      WHERE c.ai_enrolled = true
        AND ${effectiveStatusSql('c')} IN ('handoff', 'not_liquid', 'unsubscribed')
        AND c.last_message_at >= now() - ($2 || ' days')::interval
      GROUP BY c.id, c.status, c.last_message_at
     HAVING COUNT(*) FILTER (WHERE m.direction = 'in')  > 0
        AND COUNT(*) FILTER (WHERE m.direction = 'out') > 0
      ORDER BY c.last_message_at DESC
      LIMIT $1`,
    [cap, String(windowDays)],
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
    out.push({
      conversationId: conv.id,
      status: conv.status as LeadStatus,
      transcript: rows
        .map(
          (r) =>
            `${r.direction === 'in' ? 'Клиент' : 'Менеджер'}: ${r.body.trim()}`,
        )
        .join('\n'),
    })
  }
  return out
}
