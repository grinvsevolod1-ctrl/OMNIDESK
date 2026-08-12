import { query, one } from './db.js'
import {
  applyExperimentBranch,
  assignExperimentBranch,
  parseOverrides,
  type OverridableSettings,
} from '../../lib/ai/experiment.js'

/**
 * AI-assist configuration for the worker: the singleton settings row (with a
 * 30s in-process TTL cache), the chat-driven directives, A/B experiment
 * overlay, and the generation-metrics writer.
 */

/** Shared AI-assistant config (singleton row) + distilled playbook. */
export interface AiAssistConfig {
  enabled: boolean
  tone: string
  persona: string
  playbook: string[]
  /** Manager-brain model id (empty → brain's built-in default). */
  model: string
  temperature: number
  maxTokens: number
  /** Persuasion intensity 0..3 (default 2 = assertive). */
  aggressiveness: number
  /**
   * The chat-driven mandate — admin's plain-language rules from ai_directives,
   * ordered and obeyed verbatim. Empty when none set or table absent.
   */
  directives: string[]
}

/**
 * Active directives (the chat-driven mandate) as ordered plain strings.
 * Best-effort: returns [] if the table is missing (pre-085 migration) so a
 * Telegram reply is never blocked.
 */
export async function getDirectiveTexts(): Promise<string[]> {
  try {
    const rows = await query<{ body: string }>(
      `SELECT body FROM ai_directives
        WHERE enabled = true
        ORDER BY sort_order ASC, created_at ASC`,
    )
    return rows.map((r) => (r.body ?? '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Кэш настроек в памяти воркера с TTL 30 сек: конфиг читается на КАЖДОЕ
 * входящее сообщение (2 запроса — настройки + директивы), при потоке
 * сообщений это заметная нагрузка на БД. Настройки меняются из админки
 * редко; задержка применения до 30 сек — приемлемый компромисс.
 */
const SETTINGS_CACHE_TTL_MS = 30_000
let settingsCache: { value: AiAssistConfig; expiresAt: number } | null = null

/**
 * Read the singleton AI-assist settings. Missing row → disabled defaults.
 * Результат кэшируется на 30 сек (см. выше).
 */
export async function getAiAssistConfig(): Promise<AiAssistConfig> {
  if (settingsCache && Date.now() < settingsCache.expiresAt) {
    return settingsCache.value
  }
  const value = await loadAiAssistConfig()
  settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS }
  return value
}

async function loadAiAssistConfig(): Promise<AiAssistConfig> {
  // Tolerate the model-config columns being absent (pre-069 migration): select
  // them defensively so an older DB still yields a valid config.
  const row = await one<{
    enabled: boolean
    tone: string
    persona: string
    playbook: unknown
    model: string | null
    temperature: number | string | null
    max_tokens: number | string | null
    aggressiveness: number | string | null
  }>(
    `SELECT enabled, tone, persona, playbook,
            COALESCE(model, '')      AS model,
            COALESCE(temperature, 0.7) AS temperature,
            COALESCE(max_tokens, 400)  AS max_tokens,
            COALESCE(aggressiveness, 2) AS aggressiveness
       FROM ai_assist_settings WHERE id = true`,
  ).catch(async () =>
    // Fallback for pre-migration schema without the new columns.
    one<{
      enabled: boolean
      tone: string
      persona: string
      playbook: unknown
      model: null
      temperature: null
      max_tokens: null
      aggressiveness: null
    }>(
      `SELECT enabled, tone, persona, playbook,
              NULL AS model, NULL AS temperature, NULL AS max_tokens,
              NULL AS aggressiveness
         FROM ai_assist_settings WHERE id = true`,
    ),
  )
  const directives = await getDirectiveTexts()
  return {
    enabled: !!row?.enabled,
    tone: row?.tone ?? 'professional',
    persona: row?.persona ?? '',
    playbook: Array.isArray(row?.playbook) ? (row!.playbook as string[]) : [],
    model: row?.model ?? '',
    temperature: row?.temperature == null ? 0.7 : Number(row!.temperature),
    maxTokens: row?.max_tokens == null ? 400 : Number(row!.max_tokens),
    aggressiveness:
      row?.aggressiveness == null
        ? 2
        : Math.max(0, Math.min(3, Math.round(Number(row!.aggressiveness)))),
    directives,
  }
}

/**
 * Overlay the active A/B experiment (if any) onto a settings snapshot for one
 * conversation, recording the branch assignment. Mirrors the panel-side
 * lib/data/ai-experiments.ts#applyActiveExperiment — same deterministic hash
 * (shared pure core), same fail-open contract: any error, including a pre-088
 * schema, returns the settings untouched so messenger replies never break.
 */
export async function applyActiveExperiment<T extends OverridableSettings>(
  settings: T,
  conversationId: string,
): Promise<{ settings: T; extraDirectives: string[] }> {
  try {
    const row = await one<{ id: string; name: string; overrides: unknown }>(
      `SELECT id, name, overrides FROM ai_experiments
        WHERE status = 'active' LIMIT 1`,
    )
    if (!row) return { settings, extraDirectives: [] }
    const branch = assignExperimentBranch(row.id, conversationId)
    void query(
      `INSERT INTO ai_experiment_assignments (experiment_id, conversation_id, branch)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [row.id, conversationId, branch],
    ).catch(() => {})
    return applyExperimentBranch(
      settings,
      { id: row.id, name: row.name, overrides: parseOverrides(row.overrides) },
      branch,
    )
  } catch {
    return { settings, extraDirectives: [] }
  }
}

/**
 * Record one manager-brain generation metric (durable A/B analytics). Mirrors
 * lib/data/ai-assist.ts#recordAiGenerationMetric so worker + panel write the
 * same table. Best-effort: swallows errors (incl. pre-migration absence).
 */
export async function recordAiGenerationMetric(m: {
  model: string
  purpose: 'reply' | 'assess'
  outcome: 'ok' | 'empty' | 'refused' | 'http_error' | 'exception'
  latencyMs?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
  conversationId?: string | null
}): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_generation_metrics
         (model, runtime, purpose, outcome, latency_ms, prompt_tokens, completion_tokens, conversation_id)
       VALUES ($1, 'worker', $2, $3, $4, $5, $6, $7)`,
      [
        m.model || '',
        m.purpose,
        m.outcome,
        m.latencyMs ?? null,
        m.promptTokens ?? null,
        m.completionTokens ?? null,
        m.conversationId ?? null,
      ],
    )
  } catch {
    /* metrics are non-critical */
  }
}
