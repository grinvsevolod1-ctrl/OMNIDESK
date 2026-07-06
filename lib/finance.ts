import { query } from './db'
import {
  AD_PLATFORMS,
  AD_STATUSES,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  type AdPlatform,
  type AdStatus,
  type FinanceAdAccount,
  type FinanceAdStat,
  type FinanceAdTopup,
  type FinanceCurrency,
  type FinanceData,
  type FinanceEntry,
  type FinanceEntryStatus,
  type FinanceResource,
  type FinanceSection,
  type FinanceTask,
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
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
}
export type {
  AdPlatform,
  AdStatus,
  FinanceAdAccount,
  FinanceAdStat,
  FinanceAdTopup,
  FinanceCurrency,
  FinanceData,
  FinanceEntry,
  FinanceEntryStatus,
  FinanceResource,
  FinanceSection,
  FinanceTask,
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

function mapAdAccount(
  row: AdAccountRow,
  topups: FinanceAdTopup[],
  stats: FinanceAdStat[],
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
              a.currency, a.note, a.created_at, a.updated_at
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
      ),
    ),
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
}): Promise<void> {
  await query(
    `INSERT INTO finance_ad_accounts
       (resource_id, name, platform, status, account_ref, currency, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.resourceId,
      input.name,
      input.platform,
      input.status,
      input.accountRef,
      input.currency,
      input.note,
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
  },
): Promise<void> {
  await query(
    `UPDATE finance_ad_accounts
        SET name = $2, platform = $3, status = $4, account_ref = $5,
            currency = $6, note = $7, updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.name,
      input.platform,
      input.status,
      input.accountRef,
      input.currency,
      input.note,
    ],
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
