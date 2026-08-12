import 'server-only'
import { query } from '../db'

/**
 * Durable manager-brain generation metrics (drives the A/B panel).
 * Split out of ai-assist.ts (which remains the barrel — import from there).
 */

/** One manager-brain generation metric (durable A/B analytics). */
export interface AiGenerationMetricInput {
  model: string
  runtime: 'livechat' | 'worker' | 'trainer'
  purpose: 'reply' | 'assess'
  outcome: 'ok' | 'empty' | 'refused' | 'http_error' | 'exception'
  latencyMs?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  conversationId?: string | null
}

/**
 * Record one generation metric. Best-effort: never throws into the caller (a
 * metrics write must never break a reply), and tolerates the table being absent
 * pre-migration.
 */
export async function recordAiGenerationMetric(
  m: AiGenerationMetricInput,
): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_generation_metrics
         (model, runtime, purpose, outcome, latency_ms, prompt_tokens, completion_tokens, conversation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        m.model || '',
        m.runtime,
        m.purpose,
        m.outcome,
        m.latencyMs ?? null,
        m.promptTokens ?? null,
        m.completionTokens ?? null,
        m.conversationId ?? null,
      ],
    )
  } catch {
    /* metrics are non-critical — swallow (e.g. pre-migration) */
  }
}

/** Per-model aggregate stats over the last N days (drives the A/B panel). */
export interface AiModelStat {
  model: string
  total: number
  okRate: number
  avgLatencyMs: number
  avgCompletionTokens: number
}

export async function getAiModelStats(days = 7): Promise<AiModelStat[]> {
  const rows = await query<{
    model: string
    total: string
    ok: string
    avg_latency: string | null
    avg_tokens: string | null
  }>(
    `SELECT model,
            count(*)::text AS total,
            count(*) FILTER (WHERE outcome = 'ok')::text AS ok,
            avg(latency_ms) FILTER (WHERE outcome = 'ok') AS avg_latency,
            avg(completion_tokens) FILTER (WHERE outcome = 'ok') AS avg_tokens
       FROM ai_generation_metrics
      WHERE created_at >= now() - ($1 || ' days')::interval
      GROUP BY model
      ORDER BY count(*) DESC`,
    [String(Math.max(1, Math.min(90, days)))],
  )
  return rows.map((r) => {
    const total = Number(r.total) || 0
    const ok = Number(r.ok) || 0
    return {
      model: r.model || '(default)',
      total,
      okRate: total > 0 ? ok / total : 0,
      avgLatencyMs: Math.round(Number(r.avg_latency ?? 0)),
      avgCompletionTokens: Math.round(Number(r.avg_tokens ?? 0)),
    }
  })
}
