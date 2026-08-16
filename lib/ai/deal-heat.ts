import 'server-only'
import { query } from '../db'
import { effectiveStatusSql } from '../data/shared'
import type { LeadStatus } from '../types'

/**
 * Deal-heat scoring: a fast, deterministic "how hot is this client" score for
 * AI-led conversations, so the co-pilot can answer "who should we push today?"
 * or "how warm is this dialog?" in chat.
 *
 * The score is a plain heuristic over real conversation signals — lead status,
 * engagement, recency and who is waiting on whom — computed in one SQL pass so
 * it scales to a whole list without an LLM call per dialog. It works over
 * AI-enrolled conversations, exactly like the rest of the AI manager.
 */

/** How hot a single deal is, with the signals that produced the score. */
export interface DealHeat {
  conversationId: string
  contactName: string | null
  channelType: string
  status: LeadStatus
  /** 0..100 — higher means hotter / more likely to convert soon. */
  score: number
  /** Coarse bucket for quick reading. */
  band: 'hot' | 'warm' | 'cool' | 'cold'
  /** Human-readable signal breakdown, so the co-pilot can explain the score. */
  reasons: string[]
  /** Hours since the last message of any side (null when no messages). */
  hoursSinceLast: number | null
  /** True when the last message was the client's — i.e. the ball is in our court. */
  awaitingUs: boolean
  clientMessages: number
  managerMessages: number
}

interface HeatRow {
  id: string
  contact_name: string | null
  channel_type: string
  status: string
  client_msgs: string | number
  manager_msgs: string | number
  client_questions: string | number
  hours_since_last: string | number | null
  hours_since_client: string | number | null
  last_dir: 'in' | 'out' | null
}

function band(score: number): DealHeat['band'] {
  if (score >= 70) return 'hot'
  if (score >= 45) return 'warm'
  if (score >= 20) return 'cool'
  return 'cold'
}

/** Turn one aggregated row into a scored, explained DealHeat. */
function scoreRow(r: HeatRow): DealHeat {
  const status = (r.status as LeadStatus) ?? 'unsubscribed'
  const clientMessages = Number(r.client_msgs) || 0
  const managerMessages = Number(r.manager_msgs) || 0
  const clientQuestions = Number(r.client_questions) || 0
  const hoursSinceLast =
    r.hours_since_last == null ? null : Number(r.hours_since_last)
  const hoursSinceClient =
    r.hours_since_client == null ? null : Number(r.hours_since_client)
  const awaitingUs = r.last_dir === 'in'

  let score = 0
  const reasons: string[] = []

  // 1) Lead status is the strongest prior.
  switch (status) {
    case 'liquid':
      score += 45
      reasons.push('лид уже квалифицирован (ликвид)')
      break
    case 'handoff':
      score += 35
      reasons.push('клиент запросил менеджера — высокий интерес')
      break
    case 'transferred':
      score += 15
      reasons.push('передан дальше по воронке')
      break
    case 'not_liquid':
      score -= 15
      reasons.push('помечен как не-ликвид')
      break
    default:
      score += 10
      reasons.push('первичный контакт')
  }

  // 2) Engagement — a real back-and-forth is warmer than a one-off.
  if (clientMessages >= 8) {
    score += 20
    reasons.push('активная переписка')
  } else if (clientMessages >= 3) {
    score += 12
    reasons.push('несколько сообщений от клиента')
  } else if (clientMessages >= 1) {
    score += 5
  }

  // 3) Client is asking questions → active interest.
  if (clientQuestions >= 3) {
    score += 12
    reasons.push('клиент активно задаёт вопросы')
  } else if (clientQuestions >= 1) {
    score += 6
    reasons.push('клиент задаёт вопросы')
  }

  // 4) The ball is in our court and the client is waiting → act now.
  if (awaitingUs) {
    score += 12
    reasons.push('ждёт нашего ответа')
  }

  // 5) Recency decay on the client's last activity — stale deals cool off.
  if (hoursSinceClient != null) {
    if (hoursSinceClient <= 6) {
      score += 15
      reasons.push('писал только что')
    } else if (hoursSinceClient <= 24) {
      score += 8
      reasons.push('писал сегодня')
    } else if (hoursSinceClient <= 72) {
      score += 2
    } else if (hoursSinceClient <= 168) {
      score -= 8
      reasons.push('молчит несколько дней')
    } else {
      score -= 18
      reasons.push('молчит больше недели')
    }
  } else if (hoursSinceLast != null && hoursSinceLast > 168) {
    score -= 10
    reasons.push('давно нет активности')
  }

  score = Math.max(0, Math.min(100, Math.round(score)))

  return {
    conversationId: r.id,
    contactName: r.contact_name,
    channelType: r.channel_type,
    status,
    score,
    band: band(score),
    reasons,
    hoursSinceLast:
      hoursSinceLast == null ? null : Math.round(hoursSinceLast * 10) / 10,
    awaitingUs,
    clientMessages,
    managerMessages,
  }
}

/** Shared aggregate: one row per AI-enrolled conversation with heat signals. */
const HEAT_SELECT = `
  SELECT c.id,
         c.contact_name,
         c.channel_type,
         ${effectiveStatusSql('c')} AS status,
         COUNT(*) FILTER (WHERE m.direction = 'in')  AS client_msgs,
         COUNT(*) FILTER (WHERE m.direction = 'out') AS manager_msgs,
         COUNT(*) FILTER (
           WHERE m.direction = 'in' AND m.body LIKE '%?%'
         ) AS client_questions,
         EXTRACT(EPOCH FROM (now() - MAX(m.created_at))) / 3600
           AS hours_since_last,
         EXTRACT(EPOCH FROM (
           now() - MAX(m.created_at) FILTER (WHERE m.direction = 'in')
         )) / 3600 AS hours_since_client,
         (
           SELECT lm.direction FROM messages lm
            WHERE lm.conversation_id = c.id
              AND lm.deleted_at IS NULL AND lm.body <> ''
            ORDER BY lm.created_at DESC LIMIT 1
         ) AS last_dir
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
                    AND m.deleted_at IS NULL AND m.body <> ''
   WHERE c.ai_enrolled = true`

/**
 * Score every active AI-led deal and return them hottest-first. `limit` caps the
 * result (1..200).
 */
export async function listDealHeat(limit = 20): Promise<DealHeat[]> {
  const cap = Math.max(1, Math.min(200, Math.round(limit)))
  const rows = await query<HeatRow>(
    `${HEAT_SELECT}
      GROUP BY c.id, c.contact_name, c.channel_type, c.status
      ORDER BY MAX(m.created_at) DESC
      LIMIT 500`,
  )
  return rows
    .map(scoreRow)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
}

/** Score a single AI-led deal by conversation id, or null if not found/enrolled. */
export async function getDealHeat(
  conversationId: string,
): Promise<DealHeat | null> {
  const rows = await query<HeatRow>(
    `${HEAT_SELECT}
        AND c.id = $1
      GROUP BY c.id, c.contact_name, c.channel_type, c.status
      LIMIT 1`,
    [conversationId],
  )
  if (rows.length === 0) return null
  return scoreRow(rows[0])
}
