import { query } from './db'
import { decrypt, encrypt, isEncryptionConfigured } from './crypto'
import {
  AD_PLATFORMS,
  AD_STATUSES,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  VAULT_CATEGORIES,
  AD_METRIC_KEYS,
  AD_METRIC_LABELS,
  adBaseMetrics,
  adEffectiveMetrics,
  type AdMetricKey,
  type AdOverride,
  type AdPlatform,
  type AdStatus,
  type FinanceAdAccount,
  type FinanceAdStat,
  type FinanceAdSyncStat,
  type FinanceAdTopup,
  type FinanceCurrency,
  type FinanceData,
  type FinanceEntry,
  type FinanceEntryStatus,
  type FinanceResource,
  type FinanceSection,
  type FinanceTask,
  type VaultCategory,
  type VaultField,
  type VaultItem,
} from './finance-types'

/**
 * Data-access layer for the «Учёт» (finance) admin tab.
 *
 * У бизнеса нет доходов — только расходы и реклама. Ключевые метрики: ЛИДЫ,
 * расход на рекламу, баланс кабинетов, CPL.
 *
 * Модель:
 *   Ресурс (site.com)
 *     ├── Рекламные кабинеты  →  Пополнения (+баланс) + Статистика (−баланс, метрики)
 *     └── Разделы расходов (вкладки) → Записи расходов → чек-лист задач
 *
 * SQL живёт здесь; типы и enum-массивы — в ./finance-types (без импорта БД,
 * чтобы их можно было использовать в клиентских компонентах). Реэкспортируем
 * их для обратной совместимости серверных импортов из '@/lib/finance'.
 */

export {
  AD_PLATFORMS,
  AD_STATUSES,
  AD_METRIC_KEYS,
  AD_METRIC_LABELS,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  VAULT_CATEGORIES,
  adBaseMetrics,
  adEffectiveMetrics,
}
export type {
  AdMetricKey,
  AdOverride,
  AdPlatform,
  AdStatus,
  FinanceAdAccount,
  FinanceAdStat,
  FinanceAdSyncStat,
  FinanceAdTopup,
  FinanceCurrency,
  FinanceData,
  FinanceEntry,
  FinanceEntryStatus,
  FinanceResource,
  FinanceSection,
  FinanceTask,
  VaultCategory,
  VaultField,
  VaultItem,
}

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

interface ResourceRow {
  id: string
  name: string
  description: string
  currency: string
  archived: boolean
  created_at: string | Date
}

interface SectionRow {
  id: string
  resource_id: string
  name: string
  sort_order: number
  created_at: string | Date
}

interface EntryRow {
  id: string
  section_id: string
  resource_id: string
  title: string
  vendor: string | null
  amount: string | number
  status: string
  notes: string
  entry_date: string | Date
  due_date: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

interface TaskRow {
  id: string
  entry_id: string
  label: string
  done: boolean
  sort_order: number
}

interface AdAccountRow {
  id: string
  resource_id: string
  name: string
  platform: string
  status: string
  account_ref: string
  currency: string
  note: string
  created_at: string | Date
  updated_at: string | Date
  external_enabled: boolean
  yandex_login: string
  yandex_token_enc: string | null
  last_sync_at: string | Date | null
  sync_error: string
}

interface AdSyncStatRow {
  account_id: string
  period_start: string | Date
  period_end: string | Date
  impressions: string | number
  clicks: string | number
  leads: string | number
  spend: string | number
  synced_at: string | Date
}

interface AdOverrideRow {
  account_id: string
  metric: string
  value: string | number
  baseline: string | number
  updated_at: string | Date
}

interface AdTopupRow {
  id: string
  account_id: string
  amount: string | number
  topup_date: string | Date
  note: string
  created_at: string | Date
}

interface AdStatRow {
  id: string
  account_id: string
  period_start: string | Date
  period_end: string | Date
  impressions: string | number
  clicks: string | number
  leads: string | number
  spend: string | number
  note: string
  created_at: string | Date
}

interface VaultItemRow {
  id: string
  resource_id: string
  category: string
  title: string
  login: string
  secret_enc: string | null
  url: string
  extra_enc: string | null
  note: string
  tags: string[] | null
  favorite: boolean
  sort_order: number
  created_at: string | Date
  updated_at: string | Date
}

/* ------------------------------------------------------------------ */
/* Normalizers + mappers                                               */
/* ------------------------------------------------------------------ */

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function dateOnly(value: string | Date | null): string | null {
  if (value == null) return null
  return iso(value).slice(0, 10)
}

function normCurrency(value: string): FinanceCurrency {
  return FINANCE_CURRENCIES.includes(value as FinanceCurrency)
    ? (value as FinanceCurrency)
    : 'USDT'
}

function normStatus(value: string): FinanceEntryStatus {
  return FINANCE_ENTRY_STATUSES.includes(value as FinanceEntryStatus)
    ? (value as FinanceEntryStatus)
    : 'planned'
}

function normPlatform(value: string): AdPlatform {
  return AD_PLATFORMS.includes(value as AdPlatform)
    ? (value as AdPlatform)
    : 'other'
}

function normAdStatus(value: string): AdStatus {
  return AD_STATUSES.includes(value as AdStatus)
    ? (value as AdStatus)
    : 'active'
}

function normVaultCategory(value: string): VaultCategory {
  return VAULT_CATEGORIES.includes(value as VaultCategory)
    ? (value as VaultCategory)
    : 'other'
}

/** Decrypt a stored envelope, tolerating a rotated/missing key (returns ''). */
function safeDecrypt(envelope: string | null): string {
  if (!envelope) return ''
  try {
    return decrypt(envelope)
  } catch {
    // Key rotated or ciphertext tampered — never crash the whole page.
    return ''
  }
}

function normVaultFields(raw: string): VaultField[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({
        label: String((f as VaultField).label ?? ''),
        value: String((f as VaultField).value ?? ''),
        secret: Boolean((f as VaultField).secret),
      }))
  } catch {
    return []
  }
}

function mapVaultItem(row: VaultItemRow): VaultItem {
  return {
    id: row.id,
    resourceId: row.resource_id,
    category: normVaultCategory(row.category),
    title: row.title,
    login: row.login ?? '',
    secret: safeDecrypt(row.secret_enc),
    url: row.url ?? '',
    fields: normVaultFields(safeDecrypt(row.extra_enc)),
    note: row.note ?? '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    favorite: row.favorite,
    sortOrder: row.sort_order,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function mapResource(row: ResourceRow): FinanceResource {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    currency: normCurrency(row.currency),
    archived: row.archived,
    createdAt: iso(row.created_at),
  }
}

function mapSection(row: SectionRow): FinanceSection {
  return {
    id: row.id,
    resourceId: row.resource_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: iso(row.created_at),
  }
}

function mapTask(row: TaskRow): FinanceTask {
  return {
    id: row.id,
    entryId: row.entry_id,
    label: row.label,
    done: row.done,
    sortOrder: row.sort_order,
  }
}

function mapEntry(row: EntryRow, tasks: FinanceTask[]): FinanceEntry {
  return {
    id: row.id,
    sectionId: row.section_id,
    resourceId: row.resource_id,
    title: row.title,
    vendor: row.vendor ?? '',
    amount: Number(row.amount) || 0,
    status: normStatus(row.status),
    notes: row.notes ?? '',
    entryDate: iso(row.entry_date).slice(0, 10),
    dueDate: dateOnly(row.due_date),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    tasks,
  }
}

function mapTopup(row: AdTopupRow): FinanceAdTopup {
  return {
    id: row.id,
    accountId: row.account_id,
    amount: Number(row.amount) || 0,
    topupDate: iso(row.topup_date).slice(0, 10),
    note: row.note ?? '',
    createdAt: iso(row.created_at),
  }
}

function mapStat(row: AdStatRow): FinanceAdStat {
  return {
    id: row.id,
    accountId: row.account_id,
    periodStart: iso(row.period_start).slice(0, 10),
    periodEnd: iso(row.period_end).slice(0, 10),
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    leads: Number(row.leads) || 0,
    spend: Number(row.spend) || 0,
    note: row.note ?? '',
    createdAt: iso(row.created_at),
  }
}

function mapSyncStat(row: AdSyncStatRow): FinanceAdSyncStat {
  return {
    impressions: Number(row.impressions) || 0,
    clicks: Number(row.clicks) || 0,
    leads: Number(row.leads) || 0,
    spend: Number(row.spend) || 0,
    periodStart: iso(row.period_start).slice(0, 10),
    periodEnd: iso(row.period_end).slice(0, 10),
    syncedAt: iso(row.synced_at),
  }
}

function mapAdAccount(
  row: AdAccountRow,
  topups: FinanceAdTopup[],
  stats: FinanceAdStat[],
  syncStat: FinanceAdSyncStat | null,
  overrides: Partial<Record<AdMetricKey, AdOverride>>,
): FinanceAdAccount {
  return {
    id: row.id,
    resourceId: row.resource_id,
    name: row.name,
    platform: normPlatform(row.platform),
    status: normAdStatus(row.status),
    accountRef: row.account_ref ?? '',
    currency: normCurrency(row.currency),
    note: row.note ?? '',
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    topups,
    stats,
    externalEnabled: Boolean(row.external_enabled),
    yandexLogin: row.yandex_login ?? '',
    hasToken: Boolean(row.yandex_token_enc),
    lastSyncAt: row.last_sync_at ? iso(row.last_sync_at) : null,
    syncError: row.sync_error ?? '',
    syncStat,
    overrides,
  }
}

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

/* ------------------------------------------------------------------ */
/* Resources                                                           */
/* ------------------------------------------------------------------ */

export async function createFinanceResource(input: {
  name: string
  description: string
  currency: FinanceCurrency
}): Promise<FinanceResource> {
  const rows = await query<ResourceRow>(
    `INSERT INTO finance_resources (name, description, currency)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, currency, archived, created_at`,
    [input.name, input.description, input.currency],
  )
  return mapResource(rows[0])
}

export async function updateFinanceResource(
  id: string,
  input: {
    name: string
    description: string
    currency: FinanceCurrency
    archived: boolean
  },
): Promise<void> {
  await query(
    `UPDATE finance_resources
        SET name = $2, description = $3, currency = $4, archived = $5
      WHERE id = $1`,
    [id, input.name, input.description, input.currency, input.archived],
  )
}

export async function deleteFinanceResource(id: string): Promise<void> {
  await query(`DELETE FROM finance_resources WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

export async function createFinanceSection(input: {
  resourceId: string
  name: string
}): Promise<FinanceSection> {
  const rows = await query<SectionRow>(
    `INSERT INTO finance_sections (resource_id, name, sort_order)
     VALUES (
       $1, $2,
       COALESCE(
         (SELECT MAX(sort_order) + 1 FROM finance_sections WHERE resource_id = $1),
         0
       )
     )
     RETURNING id, resource_id, name, sort_order, created_at`,
    [input.resourceId, input.name],
  )
  return mapSection(rows[0])
}

export async function renameFinanceSection(
  id: string,
  name: string,
): Promise<void> {
  await query(`UPDATE finance_sections SET name = $2 WHERE id = $1`, [id, name])
}

export async function deleteFinanceSection(id: string): Promise<void> {
  await query(`DELETE FROM finance_sections WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Expense entries                                                     */
/* ------------------------------------------------------------------ */

export async function createFinanceEntry(input: {
  sectionId: string
  title: string
  vendor: string
  amount: number
  status: FinanceEntryStatus
  notes: string
  entryDate: string
  dueDate: string | null
}): Promise<void> {
  // resource_id is derived from the section so it always stays consistent.
  await query(
    `INSERT INTO finance_entries
       (section_id, resource_id, title, vendor, type, amount, status, notes,
        entry_date, due_date)
     SELECT s.id, s.resource_id, $2, $3, 'expense', $4, $5, $6, $7, $8
       FROM finance_sections s
      WHERE s.id = $1`,
    [
      input.sectionId,
      input.title,
      input.vendor,
      input.amount,
      input.status,
      input.notes,
      input.entryDate,
      input.dueDate,
    ],
  )
}

export async function updateFinanceEntry(
  id: string,
  input: {
    title: string
    vendor: string
    amount: number
    status: FinanceEntryStatus
    notes: string
    entryDate: string
    dueDate: string | null
  },
): Promise<void> {
  await query(
    `UPDATE finance_entries
        SET title = $2, vendor = $3, amount = $4, status = $5,
            notes = $6, entry_date = $7, due_date = $8, updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.title,
      input.vendor,
      input.amount,
      input.status,
      input.notes,
      input.entryDate,
      input.dueDate,
    ],
  )
}

/** Move an entry to another section (also realigns resource_id). */
export async function moveFinanceEntry(
  id: string,
  sectionId: string,
): Promise<void> {
  await query(
    `UPDATE finance_entries e
        SET section_id = s.id, resource_id = s.resource_id, updated_at = now()
       FROM finance_sections s
      WHERE e.id = $1 AND s.id = $2`,
    [id, sectionId],
  )
}

export async function deleteFinanceEntry(id: string): Promise<void> {
  await query(`DELETE FROM finance_entries WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Checklist tasks                                                     */
/* ------------------------------------------------------------------ */

export async function addFinanceTask(input: {
  entryId: string
  label: string
}): Promise<FinanceTask> {
  const rows = await query<TaskRow>(
    `INSERT INTO finance_entry_tasks (entry_id, label, sort_order)
     VALUES (
       $1, $2,
       COALESCE(
         (SELECT MAX(sort_order) + 1 FROM finance_entry_tasks WHERE entry_id = $1),
         0
       )
     )
     RETURNING id, entry_id, label, done, sort_order`,
    [input.entryId, input.label],
  )
  return mapTask(rows[0])
}

export async function setFinanceTaskDone(
  id: string,
  done: boolean,
): Promise<void> {
  await query(`UPDATE finance_entry_tasks SET done = $2 WHERE id = $1`, [
    id,
    done,
  ])
}

export async function deleteFinanceTask(id: string): Promise<void> {
  await query(`DELETE FROM finance_entry_tasks WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Ad accounts                                                         */
/* ------------------------------------------------------------------ */

export async function createFinanceAdAccount(input: {
  resourceId: string
  name: string
  platform: AdPlatform
  status: AdStatus
  accountRef: string
  currency: FinanceCurrency
  note: string
  externalEnabled: boolean
  yandexLogin: string
  /** Открытый OAuth-токен; шифруется здесь. '' = без токена. */
  yandexToken: string
}): Promise<void> {
  const tokenEnc = input.yandexToken ? encrypt(input.yandexToken) : null
  await query(
    `INSERT INTO finance_ad_accounts
       (resource_id, name, platform, status, account_ref, currency, note,
        external_enabled, yandex_login, yandex_token_enc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.resourceId,
      input.name,
      input.platform,
      input.status,
      input.accountRef,
      input.currency,
      input.note,
      input.externalEnabled,
      input.yandexLogin,
      tokenEnc,
    ],
  )
}

export async function updateFinanceAdAccount(
  id: string,
  input: {
    name: string
    platform: AdPlatform
    status: AdStatus
    accountRef: string
    currency: FinanceCurrency
    note: string
    externalEnabled: boolean
    yandexLogin: string
    /** undefined/'' = не менять токен; строка = задать новый. */
    yandexToken?: string
  },
): Promise<void> {
  // Токен обновляем только если передали новое значение — иначе сохраняем
  // существующий зашифрованный токен (COALESCE на NULL).
  const tokenEnc = input.yandexToken ? encrypt(input.yandexToken) : null
  await query(
    `UPDATE finance_ad_accounts
        SET name = $2, platform = $3, status = $4, account_ref = $5,
            currency = $6, note = $7, external_enabled = $8, yandex_login = $9,
            yandex_token_enc = COALESCE($10, yandex_token_enc),
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.name,
      input.platform,
      input.status,
      input.accountRef,
      input.currency,
      input.note,
      input.externalEnabled,
      input.yandexLogin,
      tokenEnc,
    ],
  )
}

/* ------------------------------------------------------------------ */
/* Ad metrics: base values + god-page overrides                        */
/* ------------------------------------------------------------------ */

/**
 * «Сырые» метрики кабинета на сервере: из последнего снимка Яндекса, если
 * интеграция включена, иначе — сумма ручных снимков статистики. Используется
 * god-страницей, чтобы зафиксировать baseline в момент установки корректировки.
 */
export async function getAdBaseMetrics(
  accountId: string,
): Promise<Record<AdMetricKey, number>> {
  const accRows = await query<{ external_enabled: boolean }>(
    `SELECT external_enabled FROM finance_ad_accounts WHERE id = $1`,
    [accountId],
  )
  if (!accRows[0]) return { impressions: 0, clicks: 0, leads: 0, spend: 0 }

  if (accRows[0].external_enabled) {
    const rows = await query<AdSyncStatRow>(
      `SELECT account_id, period_start, period_end, impressions, clicks,
              leads, spend, synced_at
         FROM finance_ad_sync_stats WHERE account_id = $1`,
      [accountId],
    )
    const s = rows[0]
    return {
      impressions: s ? Number(s.impressions) || 0 : 0,
      clicks: s ? Number(s.clicks) || 0 : 0,
      leads: s ? Number(s.leads) || 0 : 0,
      spend: s ? Number(s.spend) || 0 : 0,
    }
  }

  const rows = await query<{
    impressions: string | number
    clicks: string | number
    leads: string | number
    spend: string | number
  }>(
    `SELECT COALESCE(SUM(impressions), 0) AS impressions,
            COALESCE(SUM(clicks), 0)      AS clicks,
            COALESCE(SUM(leads), 0)       AS leads,
            COALESCE(SUM(spend), 0)       AS spend
       FROM finance_ad_stats WHERE account_id = $1`,
    [accountId],
  )
  const s = rows[0]
  return {
    impressions: Number(s?.impressions) || 0,
    clicks: Number(s?.clicks) || 0,
    leads: Number(s?.leads) || 0,
    spend: Number(s?.spend) || 0,
  }
}

/** Зафиксировать ручную корректировку метрики с текущим baseline из Яндекса. */
export async function setAdOverride(
  accountId: string,
  metric: AdMetricKey,
  value: number,
): Promise<void> {
  const base = await getAdBaseMetrics(accountId)
  await query(
    `INSERT INTO finance_ad_overrides (account_id, metric, value, baseline, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (account_id, metric) DO UPDATE SET
       value = EXCLUDED.value,
       baseline = EXCLUDED.baseline,
       updated_at = now()`,
    [accountId, metric, value, base[metric]],
  )
}

/** Снять ручную корректировку — метрика снова показывает данные Яндекса. */
export async function clearAdOverride(
  accountId: string,
  metric: AdMetricKey,
): Promise<void> {
  await query(
    `DELETE FROM finance_ad_overrides WHERE account_id = $1 AND metric = $2`,
    [accountId, metric],
  )
}

export async function deleteFinanceAdAccount(id: string): Promise<void> {
  await query(`DELETE FROM finance_ad_accounts WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Ad top-ups                                                          */
/* ------------------------------------------------------------------ */

export async function addFinanceAdTopup(input: {
  accountId: string
  amount: number
  topupDate: string
  note: string
}): Promise<void> {
  await query(
    `INSERT INTO finance_ad_topups (account_id, amount, topup_date, note)
     VALUES ($1, $2, $3, $4)`,
    [input.accountId, input.amount, input.topupDate, input.note],
  )
}

export async function deleteFinanceAdTopup(id: string): Promise<void> {
  await query(`DELETE FROM finance_ad_topups WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Ad stats                                                            */
/* ------------------------------------------------------------------ */

export async function addFinanceAdStat(input: {
  accountId: string
  periodStart: string
  periodEnd: string
  impressions: number
  clicks: number
  leads: number
  spend: number
  note: string
}): Promise<void> {
  await query(
    `INSERT INTO finance_ad_stats
       (account_id, period_start, period_end, impressions, clicks, leads, spend, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.accountId,
      input.periodStart,
      input.periodEnd,
      input.impressions,
      input.clicks,
      input.leads,
      input.spend,
      input.note,
    ],
  )
}

export async function deleteFinanceAdStat(id: string): Promise<void> {
  await query(`DELETE FROM finance_ad_stats WHERE id = $1`, [id])
}

/* ------------------------------------------------------------------ */
/* Vault (Хранилище)                                                   */
/* ------------------------------------------------------------------ */

interface VaultInput {
  category: VaultCategory
  title: string
  login: string
  /** Plaintext secret; encrypted here before it touches the DB. '' -> NULL. */
  secret: string
  url: string
  /** Custom fields; serialized + encrypted as one blob. [] -> NULL. */
  fields: VaultField[]
  note: string
  tags: string[]
  favorite: boolean
}

/** Encrypt the main secret; empty -> NULL so we never store an empty envelope. */
function encSecret(secret: string): string | null {
  return secret ? encrypt(secret) : null
}

/** Encrypt the custom fields blob; empty -> NULL. */
function encFields(fields: VaultField[]): string | null {
  if (!fields.length) return null
  const clean = fields
    .map((f) => ({
      label: String(f.label ?? '').trim(),
      value: String(f.value ?? ''),
      secret: Boolean(f.secret),
    }))
    .filter((f) => f.label || f.value)
  return clean.length ? encrypt(JSON.stringify(clean)) : null
}

export async function createFinanceVaultItem(
  resourceId: string,
  input: VaultInput,
): Promise<void> {
  await query(
    `INSERT INTO finance_vault_items
       (resource_id, category, title, login, secret_enc, url, extra_enc,
        note, tags, favorite, sort_order)
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       COALESCE(
         (SELECT MAX(sort_order) + 1 FROM finance_vault_items WHERE resource_id = $1),
         0
       )
     )`,
    [
      resourceId,
      input.category,
      input.title,
      input.login,
      encSecret(input.secret),
      input.url,
      encFields(input.fields),
      input.note,
      input.tags,
      input.favorite,
    ],
  )
}

export async function updateFinanceVaultItem(
  id: string,
  input: VaultInput,
): Promise<void> {
  await query(
    `UPDATE finance_vault_items
        SET category = $2, title = $3, login = $4, secret_enc = $5, url = $6,
            extra_enc = $7, note = $8, tags = $9, favorite = $10,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.category,
      input.title,
      input.login,
      encSecret(input.secret),
      input.url,
      encFields(input.fields),
      input.note,
      input.tags,
      input.favorite,
    ],
  )
}

export async function setFinanceVaultFavorite(
  id: string,
  favorite: boolean,
): Promise<void> {
  await query(
    `UPDATE finance_vault_items SET favorite = $2, updated_at = now() WHERE id = $1`,
    [id, favorite],
  )
}

export async function deleteFinanceVaultItem(id: string): Promise<void> {
  await query(`DELETE FROM finance_vault_items WHERE id = $1`, [id])
}
