/**
 * Client-sim campaigns: bounded burst of new dialogues with a target and deadline.
 */

import {
  query,
} from '@/lib/db'
import {
  type SimSettings,
} from '../types'
import {
  clampInt,
  getExistingOptionalCols,
} from './internal'
import { getSettings } from './settings'

/* -------------------------------- campaign ------------------------------ */

/** Thrown when campaign mode is used on a DB that hasn't applied migration 062. */
export class CampaignUnavailableError extends Error {}

/** Guard: campaign columns (migration 062) must exist before campaign writes. */
async function assertCampaignCols(): Promise<void> {
  const cols = await getExistingOptionalCols()
  const needed = [
    'campaign_active',
    'campaign_target',
    'campaign_ends_at',
    'campaign_started_at',
    'campaign_baseline',
  ]
  if (!needed.every((c) => cols.has(c))) {
    throw new CampaignUnavailableError(
      'Режим кампаний недоступен: примените миграцию 062_client_sim_campaign.sql.',
    )
  }
}

/**
 * Start a campaign: open `target` brand-new dialogues, paced to finish within
 * `hours`. Also flips the simulator on and primes the spawn slot so it can
 * begin immediately. Baseline is the current spawned_total, so campaign
 * progress is measured from now.
 */
export async function startCampaign(
  target: number,
  hours: number,
): Promise<SimSettings> {
  await assertCampaignCols()
  const t = clampInt(target, 1, 5_000)
  const h = Math.min(Math.max(Number(hours) || 0, 0.05), 720) // 3 min … 30 days
  await query(
    `UPDATE sim_settings
        SET enabled = true,
            started_at = now(),
            next_spawn_at = now(),
            campaign_active = true,
            campaign_target = $1,
            campaign_ends_at = now() + make_interval(secs => $2::int),
            campaign_started_at = now(),
            campaign_baseline = spawned_total,
            updated_at = now()
      WHERE id = true`,
    [t, Math.round(h * 3600)],
  )
  return getSettings()
}

/**
 * Stop the active campaign (clears the campaign flags). Leaves `enabled` as-is
 * so the operator's steady dialogs_per_day rate resumes only if they still want
 * the simulator running. `keepEnabled=false` also switches the simulator off.
 */
export async function stopCampaign(keepEnabled = true): Promise<SimSettings> {
  await assertCampaignCols()
  await query(
    `UPDATE sim_settings
        SET campaign_active = false,
            campaign_target = 0,
            campaign_ends_at = NULL,
            campaign_started_at = NULL,
            ${keepEnabled ? '' : 'enabled = false,'}
            updated_at = now()
      WHERE id = true`,
  )
  return getSettings()
}
