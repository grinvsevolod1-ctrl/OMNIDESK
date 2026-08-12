import 'server-only'
import { query } from '../db'

/**
 * Singleton AI-assistant configuration + distilled playbook.
 * Split out of ai-assist.ts (which remains the barrel — import from there).
 */

/** Shared (singleton) AI-assistant configuration + distilled playbook. */
export interface AiAssistSettings {
  enabled: boolean
  tone: string
  persona: string
  playbook: string[]
  /** Manager-brain model id (empty → code default 'openai/gpt-4.1'). */
  model: string
  /** Sampling temperature 0..2. */
  temperature: number
  /** Max completion tokens per reply. */
  maxTokens: number
  /**
   * Persuasion intensity 0..3 (0 gentle, 1 steady, 2 assertive default,
   * 3 relentless). Scales how hard the sales brain pushes toward the goal —
   * always bounded by the ethical floor baked into the system prompt.
   */
  aggressiveness: number
  updatedAt: string
}

interface SettingsRow {
  enabled: boolean
  tone: string
  persona: string
  playbook: string[] | null
  model: string | null
  temperature: number | string | null
  max_tokens: number | string | null
  aggressiveness: number | string | null
  updated_at: string | Date
}

function mapSettings(r: SettingsRow): AiAssistSettings {
  return {
    enabled: r.enabled,
    tone: r.tone ?? 'professional',
    persona: r.persona ?? '',
    playbook: Array.isArray(r.playbook) ? r.playbook : [],
    model: r.model ?? '',
    temperature: r.temperature == null ? 0.7 : Number(r.temperature),
    maxTokens: r.max_tokens == null ? 400 : Number(r.max_tokens),
    aggressiveness:
      r.aggressiveness == null
        ? 2
        : Math.max(0, Math.min(3, Math.round(Number(r.aggressiveness)))),
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/** Read the singleton settings row, creating it lazily if missing. */
export async function getAiAssistSettings(): Promise<AiAssistSettings> {
  const rows = await query<SettingsRow>(
    `INSERT INTO ai_assist_settings (id) VALUES (true)
       ON CONFLICT (id) DO UPDATE SET id = true
     RETURNING enabled, tone, persona, playbook, model, temperature, max_tokens, aggressiveness, updated_at`,
  )
  return mapSettings(rows[0])
}

/** Update the shared config (tone / persona / master switch / model tuning). */
export async function updateAiAssistSettings(patch: {
  enabled?: boolean
  tone?: string
  persona?: string
  model?: string
  temperature?: number
  maxTokens?: number
  aggressiveness?: number
}): Promise<AiAssistSettings> {
  const aggr =
    patch.aggressiveness == null
      ? null
      : Math.max(0, Math.min(3, Math.round(patch.aggressiveness)))
  const rows = await query<SettingsRow>(
    `UPDATE ai_assist_settings SET
        enabled       = COALESCE($1, enabled),
        tone          = COALESCE($2, tone),
        persona       = COALESCE($3, persona),
        model         = COALESCE($4, model),
        temperature   = COALESCE($5, temperature),
        max_tokens    = COALESCE($6, max_tokens),
        aggressiveness = COALESCE($7, aggressiveness),
        updated_at = now()
      WHERE id = true
      RETURNING enabled, tone, persona, playbook, model, temperature, max_tokens, aggressiveness, updated_at`,
    [
      patch.enabled ?? null,
      patch.tone ?? null,
      patch.persona ?? null,
      patch.model ?? null,
      patch.temperature ?? null,
      patch.maxTokens ?? null,
      aggr,
    ],
  )
  if (rows.length === 0) {
    // Row didn't exist yet — create then retry once.
    await getAiAssistSettings()
    return updateAiAssistSettings(patch)
  }
  return mapSettings(rows[0])
}

/** Overwrite the distilled playbook (called after training). */
export async function savePlaybook(playbook: string[]): Promise<void> {
  await query(
    `UPDATE ai_assist_settings
        SET playbook = $1::jsonb, updated_at = now()
      WHERE id = true`,
    [JSON.stringify(playbook)],
  )
}
