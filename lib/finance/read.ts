/**
 * Finance reads: load the entire finance tree in a few flat queries.
 */

import {
  query,
} from '../db'
import {
  isEncryptionConfigured,
} from '../crypto'
import {
  AD_METRIC_KEYS,
  type AdMetricKey,
  type AdOverride,
  type FinanceAdStat,
  type FinanceAdSyncStat,
  type FinanceAdTopup,
  type FinanceData,
  type FinanceTask,
} from '../finance-types'
import {
  iso,
  mapAdAccount,
  mapEntry,
  mapResource,
  mapSection,
  mapStat,
  mapSyncStat,
  mapTask,
  mapTopup,
  mapVaultItem,
  type AdAccountRow,
  type AdOverrideRow,
  type AdStatRow,
  type AdSyncStatRow,
  type AdTopupRow,
  type EntryRow,
  type ResourceRow,
  type SectionRow,
  type TaskRow,
  type VaultItemRow,
} from './rows'

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Load the entire finance tree in a few flat queries. */
export async function getFinanceData(): Promise<FinanceData> {
  const [
    resourceRows,
    sectionRows,
    entryRows,
    taskRows,
    accountRows,
    topupRows,
    statRows,
    syncStatRows,
    overrideRows,
    vaultRows,
  ] = await Promise.all([
    query<ResourceRow>(
      `SELECT r.id, r.name, r.description, r.currency, r.archived, r.created_at
         FROM finance_resources r
        ORDER BY r.archived ASC, r.created_at ASC`,
    ),
    query<SectionRow>(
      `SELECT s.id, s.resource_id, s.name, s.sort_order, s.created_at
         FROM finance_sections s
        ORDER BY s.sort_order ASC, s.created_at ASC`,
    ),
    query<EntryRow>(
      `SELECT e.id, e.section_id, e.resource_id, e.title, e.vendor, e.amount,
              e.orig_amount, e.orig_currency, e.fx_rate,
              e.status, e.notes, e.entry_date, e.due_date, e.created_at, e.updated_at
       FROM finance_entries e
        ORDER BY e.entry_date DESC, e.created_at DESC`,
    ),
    query<TaskRow>(
      `SELECT t.id, t.entry_id, t.label, t.done, t.sort_order
         FROM finance_entry_tasks t
        ORDER BY t.sort_order ASC, t.created_at ASC`,
    ),
    query<AdAccountRow>(
      `SELECT a.id, a.resource_id, a.name, a.platform, a.status, a.account_ref,
              a.currency, a.note, a.created_at, a.updated_at,
              a.external_enabled, a.yandex_login, a.yandex_token_enc,
              a.last_sync_at, a.sync_error
         FROM finance_ad_accounts a
        ORDER BY a.created_at ASC`,
    ),
    query<AdTopupRow>(
      `SELECT p.id, p.account_id, p.amount, p.topup_date, p.note, p.created_at
         FROM finance_ad_topups p
        ORDER BY p.topup_date DESC, p.created_at DESC`,
    ),
    query<AdStatRow>(
      `SELECT st.id, st.account_id, st.period_start, st.period_end,
              st.impressions, st.clicks, st.leads, st.spend, st.note, st.created_at
         FROM finance_ad_stats st
        ORDER BY st.period_start DESC, st.created_at DESC`,
    ),
    query<AdSyncStatRow>(
      `SELECT s.account_id, s.period_start, s.period_end, s.impressions,
              s.clicks, s.leads, s.spend, s.synced_at
         FROM finance_ad_sync_stats s`,
    ),
    query<AdOverrideRow>(
      `SELECT o.account_id, o.metric, o.value, o.baseline, o.updated_at
         FROM finance_ad_overrides o`,
    ),
    query<VaultItemRow>(
      `SELECT v.id, v.resource_id, v.category, v.title, v.login, v.secret_enc,
              v.url, v.extra_enc, v.note, v.tags, v.favorite, v.sort_order,
              v.created_at, v.updated_at
         FROM finance_vault_items v
        ORDER BY v.favorite DESC, v.sort_order ASC, v.created_at DESC`,
    ),
  ])

  const tasksByEntry = new Map<string, FinanceTask[]>()
  for (const row of taskRows) {
    const task = mapTask(row)
    const list = tasksByEntry.get(task.entryId)
    if (list) list.push(task)
    else tasksByEntry.set(task.entryId, [task])
  }

  const topupsByAccount = new Map<string, FinanceAdTopup[]>()
  for (const row of topupRows) {
    const topup = mapTopup(row)
    const list = topupsByAccount.get(topup.accountId)
    if (list) list.push(topup)
    else topupsByAccount.set(topup.accountId, [topup])
  }

  const statsByAccount = new Map<string, FinanceAdStat[]>()
  for (const row of statRows) {
    const stat = mapStat(row)
    const list = statsByAccount.get(stat.accountId)
    if (list) list.push(stat)
    else statsByAccount.set(stat.accountId, [stat])
  }

  const syncByAccount = new Map<string, FinanceAdSyncStat>()
  for (const row of syncStatRows) {
    syncByAccount.set(row.account_id, mapSyncStat(row))
  }

  const overridesByAccount = new Map<
    string,
    Partial<Record<AdMetricKey, AdOverride>>
  >()
  for (const row of overrideRows) {
    if (!AD_METRIC_KEYS.includes(row.metric as AdMetricKey)) continue
    const metric = row.metric as AdMetricKey
    const entry = overridesByAccount.get(row.account_id) ?? {}
    entry[metric] = {
      value: Number(row.value) || 0,
      baseline: Number(row.baseline) || 0,
      updatedAt: iso(row.updated_at),
    }
    overridesByAccount.set(row.account_id, entry)
  }

  return {
    resources: resourceRows.map(mapResource),
    sections: sectionRows.map(mapSection),
    entries: entryRows.map((row) =>
      mapEntry(row, tasksByEntry.get(row.id) ?? []),
    ),
    adAccounts: accountRows.map((row) =>
      mapAdAccount(
        row,
        topupsByAccount.get(row.id) ?? [],
        statsByAccount.get(row.id) ?? [],
        syncByAccount.get(row.id) ?? null,
        overridesByAccount.get(row.id) ?? {},
      ),
    ),
    vaultItems: vaultRows.map(mapVaultItem),
    encryptionReady: isEncryptionConfigured(),
  }
}
