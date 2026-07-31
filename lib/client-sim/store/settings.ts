/**
 * Client-sim settings: read/update the singleton sim_settings row, spawn counters and full reset.
 */

import {
  query,
} from '@/lib/db'
import {
  type SimContentConfig,
  type SimSettings,
  type SimTone,
} from '../types'
import {
  clearGlobalLineMemory,
} from '../line-memory'
import {
  OPTIONAL_SETTINGS_COLS,
  SETTINGS_COLS_BASE,
  TONES,
  clampInt,
  getExistingOptionalCols,
  isUndefinedColumn,
  resetOptionalColsCache,
  mapSettings,
  type SettingsRow,
} from './internal'

/**
 * Read the singleton settings row, creating it if missing. Selects only the
 * optional columns that actually exist (probed at runtime) and fills defaults
 * for the rest — so it works on any DB regardless of which migrations have run,
 * and never throws a 500 (or logs a scary query failure) that would take down
 * the whole god panel.
 */
export async function getSettings(): Promise<SimSettings> {
  const existing = await getExistingOptionalCols()
  const present = OPTIONAL_SETTINGS_COLS.filter((c) => existing.has(c))
  const cols = present.length
    ? `${SETTINGS_COLS_BASE}, ${present.join(', ')}`
    : SETTINGS_COLS_BASE

  const selectRow = async (): Promise<SettingsRow | undefined> => {
    const rows = await query<Partial<SettingsRow>>(
      `SELECT ${cols} FROM sim_settings WHERE id = true LIMIT 1`,
    )
    const r = rows[0]
    if (!r) return undefined
    // Fill defaults for any optional column not selected (missing on this DB).
    return {
      tone: 'mixed',
      dialogs_per_day: 20,
      max_concurrent: 100,
      campaign_active: false,
      campaign_target: 0,
      campaign_ends_at: null,
      campaign_started_at: null,
      campaign_baseline: 0,
      content_config: null,
      ...r,
    } as SettingsRow
  }

  const row = await selectRow()
  if (row) return mapSettings(row)
  await query(`INSERT INTO sim_settings (id) VALUES (true) ON CONFLICT DO NOTHING`)
  const again = await selectRow()
  return mapSettings(again as SettingsRow)
}
export interface SettingsPatch {
  enabled?: boolean
  channelIds?: string[]
  dialogsPerDay?: number
  maxConcurrent?: number
  aggression?: number
  tone?: SimTone
  maxThreads?: number
  spawnMinSec?: number
  spawnMaxSec?: number
  replyMinSec?: number
  replyMaxSec?: number
}

/**
 * Partial update of the settings row. Enabling stamps started_at.
 *
 * Assignments to columns added by optional migrations (`tone`, `dialogs_per_day`)
 * are marked optional: if the target column doesn't exist yet, the whole update
 * is transparently retried without the optional assignments so the rest still
 * lands instead of 500-ing.
 */
export async function updateSettings(patch: SettingsPatch): Promise<SimSettings> {
  // Each assignment is `col = $n`; `optional` ones are dropped on undefined_column.
  const assignments: Array<{ col: string; val: unknown; optional?: boolean }> = []
  // Raw SQL fragments with no bound params (e.g. now()).
  const rawSets: string[] = ['updated_at = now()']

  if (patch.enabled !== undefined) {
    assignments.push({ col: 'enabled', val: patch.enabled })
    // Stamp started_at the moment it flips on; keep the schedule primed so the
    // engine can spawn immediately rather than waiting a full cycle.
    if (patch.enabled) rawSets.push('started_at = now()', 'next_spawn_at = now()')
  }
  if (patch.channelIds !== undefined)
    assignments.push({ col: 'channel_ids', val: patch.channelIds })
  if (patch.dialogsPerDay !== undefined)
    assignments.push({
      col: 'dialogs_per_day',
      val: clampInt(patch.dialogsPerDay, 1, 5_000),
      optional: true,
    })
  if (patch.maxConcurrent !== undefined)
    assignments.push({
      col: 'max_concurrent',
      val: clampInt(patch.maxConcurrent, 1, 1_000),
      optional: true,
    })
  if (patch.aggression !== undefined)
    assignments.push({ col: 'aggression', val: clampInt(patch.aggression, 0, 100) })
  if (patch.maxThreads !== undefined)
    // 0 means unlimited. No upper bound enforced here.
    assignments.push({ col: 'max_threads', val: Math.max(0, Math.floor(patch.maxThreads) || 0) })
  if (patch.spawnMinSec !== undefined)
    assignments.push({ col: 'spawn_min_sec', val: clampInt(patch.spawnMinSec, 5, 86_400) })
  if (patch.spawnMaxSec !== undefined)
    assignments.push({ col: 'spawn_max_sec', val: clampInt(patch.spawnMaxSec, 5, 86_400) })
  if (patch.replyMinSec !== undefined)
    assignments.push({ col: 'reply_min_sec', val: clampInt(patch.replyMinSec, 1, 86_400) })
  if (patch.replyMaxSec !== undefined)
    assignments.push({ col: 'reply_max_sec', val: clampInt(patch.replyMaxSec, 1, 86_400) })
  if (patch.tone !== undefined)
    assignments.push({
      col: 'tone',
      val: TONES.includes(patch.tone) ? patch.tone : 'mixed',
      optional: true,
    })

  const run = async (list: typeof assignments) => {
    const params: unknown[] = []
    const sets = [...rawSets]
    for (const a of list) {
      params.push(a.val)
      sets.push(`${a.col} = $${params.length}`)
    }
    await query(`UPDATE sim_settings SET ${sets.join(', ')} WHERE id = true`, params)
  }

  // Drop assignments to optional columns that don't exist on this DB, so we
  // never reference a missing column (the runtime probe is authoritative).
  const existing = await getExistingOptionalCols()
  const effective = assignments.filter((a) => !a.optional || existing.has(a.col))

  try {
    await run(effective)
  } catch (err) {
    const hasOptional = effective.some((a) => a.optional)
    if (hasOptional && isUndefinedColumn(err)) {
      // Backstop: if the probe was stale, retry without optional assignments so
      // the rest of the save still lands instead of 500-ing.
      resetOptionalColsCache()
      await run(effective.filter((a) => !a.optional))
    } else {
      throw err
    }
  }
  return getSettings()
}

/**
 * Atomically claim the next spawn slot. Returns true only for the single caller
 * that wins the race (guards against double-spawning across concurrent ticks).
 * On success it also reschedules the next spawn window. The `spawned_total`
 * counter is NOT bumped here — call `bumpSpawnedTotal()` once the conversation
 * is actually created so the stat only counts real spawns.
 */
export async function claimSpawnSlot(nextDelaySec: number): Promise<boolean> {
  const rows = await query<{ id: boolean }>(
    `UPDATE sim_settings
        SET next_spawn_at = now() + make_interval(secs => $1::int),
            updated_at = now()
      WHERE id = true
        AND enabled = true
        AND (next_spawn_at IS NULL OR next_spawn_at <= now())
      RETURNING id`,
    [Math.max(1, Math.floor(nextDelaySec))],
  )
  return rows.length > 0
}

/** Record that a conversation was actually spawned. */
export async function bumpSpawnedTotal(): Promise<void> {
  await query(
    `UPDATE sim_settings SET spawned_total = spawned_total + 1, updated_at = now() WHERE id = true`,
  )
}

export async function bumpRepliesTotal(): Promise<void> {
  await query(
    `UPDATE sim_settings SET replies_total = replies_total + 1, updated_at = now() WHERE id = true`,
  )
}

/**
 * Full reset of the simulator's data. Deletes EVERY conversation the simulator
 * ever created (is_simulated = true) — their messages, sim_threads, scorecards,
 * ai_memory, etc. cascade away via ON DELETE CASCADE — then zeroes the lifetime
 * counters and clears any active campaign for a clean slate. Real human dialogs
 * are never is_simulated = true (the simulator can't adopt them — see migration
 * 065), so they are guaranteed untouched. Returns how many were removed.
 */
export async function resetSimulation(): Promise<number> {
  const removed = await query<{ id: string }>(
    `DELETE FROM conversations WHERE is_simulated = true RETURNING id`,
  )

  // Zero the always-present counters. Campaign columns are migration-gated, so
  // only clear them when present (older DBs simply skip that part).
  const cols = await getExistingOptionalCols()
  const hasCampaign = [
    'campaign_active',
    'campaign_target',
    'campaign_ends_at',
    'campaign_started_at',
    'campaign_baseline',
  ].every((c) => cols.has(c))
  await query(
    `UPDATE sim_settings
        SET spawned_total = 0,
            replies_total = 0,${
              hasCampaign
                ? `
            campaign_active = false,
            campaign_target = 0,
            campaign_ends_at = NULL,
            campaign_started_at = NULL,
            campaign_baseline = 0,`
                : ''
            }
            updated_at = now()
      WHERE id = true`,
  )

  // The swarm anti-repetition memory is in-process; clear it so the next run
  // starts truly fresh instead of avoiding phrases from a population that no
  // longer exists.
  clearGlobalLineMemory()

  return removed.length
}

/**
 * Persist the operator-edited content config. Merges with existing JSON so
 * partial updates don't wipe unrelated keys. Pass null to reset to defaults.
 */
export async function updateContentConfig(
  config: SimContentConfig | null,
): Promise<SimSettings> {
  const existing = await getExistingOptionalCols()
  if (!existing.has('content_config')) {
    // Migration 080 not yet applied — silently skip the write.
    return getSettings()
  }
  if (config === null) {
    await query(
      `UPDATE sim_settings SET content_config = NULL, updated_at = now() WHERE id = true`,
    )
  } else {
    await query(
      `UPDATE sim_settings
          SET content_config = COALESCE(content_config, '{}'::jsonb) || $1::jsonb,
              updated_at = now()
        WHERE id = true`,
      [JSON.stringify(config)],
    )
  }
  return getSettings()
}
