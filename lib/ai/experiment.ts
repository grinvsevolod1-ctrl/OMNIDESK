/**
 * A/B experiments over the seller brain — PURE shared core.
 *
 * Dependency-free on purpose (same rule as manager-brain.ts): this module is
 * imported both by the Next.js panel and by the standalone worker via a
 * relative path, so it must not touch the DB, environment, or any framework.
 *
 * Model: exactly one experiment can be active. Branch «A» is the CONTROL —
 * the seller behaves exactly as the master settings dictate. Branch «B» is
 * the VARIANT — master settings with the experiment's overrides applied.
 * A conversation's branch is a deterministic hash of (experimentId,
 * conversationId): stable across processes and restarts with no coordination,
 * so the panel, the follow-up sweep, and the worker all agree on which side
 * of the split any given client is — even before the assignment row lands.
 */

/** What an experiment may change on branch B. All fields optional. */
export interface ExperimentOverrides {
  persona?: string
  tone?: string
  /** 0..3, same scale as the master setting. */
  aggressiveness?: number
  /**
   * Extra transient directive prepended for branch-B generations only (e.g.
   * «Предлагай рассрочку в первом же ответе»). Never persisted as a rule.
   */
  extraDirective?: string
}

export type ExperimentBranch = 'A' | 'B'

/** An active experiment, as the reply paths see it. */
export interface ActiveExperimentLite {
  id: string
  name: string
  overrides: ExperimentOverrides
}

/**
 * Deterministic 50/50 split. FNV-1a over experimentId + conversationId: fast,
 * dependency-free, and uniform enough for a two-way split. Including the
 * experiment id re-shuffles clients between experiments so the same clients
 * don't always land in the variant bucket.
 */
export function assignExperimentBranch(
  experimentId: string,
  conversationId: string,
): ExperimentBranch {
  const s = `${experimentId}:${conversationId}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 2 === 0 ? 'A' : 'B'
}

/** The subset of master settings an experiment can shadow. */
export interface OverridableSettings {
  persona: string
  tone: string
  aggressiveness: number
}

/**
 * Apply an experiment to a settings snapshot for one conversation. Branch A
 * returns the input untouched (control must stay pristine). Branch B gets the
 * overrides layered on top, plus the optional extra directive to prepend.
 */
export function applyExperimentBranch<T extends OverridableSettings>(
  settings: T,
  experiment: ActiveExperimentLite,
  branch: ExperimentBranch,
): { settings: T; extraDirectives: string[] } {
  if (branch === 'A') return { settings, extraDirectives: [] }
  const o = experiment.overrides ?? {}
  const next: T = {
    ...settings,
    ...(typeof o.persona === 'string' && o.persona.trim()
      ? { persona: o.persona.trim() }
      : null),
    ...(typeof o.tone === 'string' && o.tone.trim()
      ? { tone: o.tone.trim() }
      : null),
    ...(typeof o.aggressiveness === 'number' &&
    Number.isFinite(o.aggressiveness)
      ? {
          aggressiveness: Math.max(
            0,
            Math.min(3, Math.round(o.aggressiveness)),
          ),
        }
      : null),
  }
  const extra =
    typeof o.extraDirective === 'string' && o.extraDirective.trim()
      ? [o.extraDirective.trim()]
      : []
  return { settings: next, extraDirectives: extra }
}

/** Parse a jsonb overrides blob defensively (bad rows must never crash replies). */
export function parseOverrides(raw: unknown): ExperimentOverrides {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: ExperimentOverrides = {}
  if (typeof r.persona === 'string') out.persona = r.persona
  if (typeof r.tone === 'string') out.tone = r.tone
  if (typeof r.aggressiveness === 'number') {
    out.aggressiveness = r.aggressiveness
  }
  if (typeof r.extraDirective === 'string') {
    out.extraDirective = r.extraDirective
  }
  return out
}
