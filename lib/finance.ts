import { query } from './db'

/**
 * Data-access layer for the «Учёт» (finance) admin tab.
 *
 * Three-level model: Resource → Section (tab) → Entry → checklist Tasks.
 * All SQL lives here; server actions and pages import from this module.
 */

export type FinanceCurrency = 'USDT' | 'RUB'
export type FinanceEntryType = 'income' | 'expense'
export type FinanceEntryStatus =
  | 'planned'
  | 'in_progress'
  | 'done'
  | 'cancelled'

export const FINANCE_CURRENCIES: FinanceCurrency[] = ['USDT', 'RUB']
export const FINANCE_ENTRY_TYPES: FinanceEntryType[] = ['income', 'expense']
export const FINANCE_ENTRY_STATUSES: FinanceEntryStatus[] = [
  'planned',
  'in_progress',
  'done',
  'cancelled',
]

export interface FinanceTask {
  id: string
  entryId: string
  label: string
  done: boolean
  sortOrder: number
}

export interface FinanceEntry {
  id: string
  sectionId: string
  resourceId: string
  title: string
  type: FinanceEntryType
  amount: number
  status: FinanceEntryStatus
  notes: string
  entryDate: string
  createdAt: string
  updatedAt: string
  tasks: FinanceTask[]
}

export interface FinanceSection {
  id: string
  resourceId: string
  name: string
  sortOrder: number
  createdAt: string
}

export interface FinanceResource {
  id: string
  name: string
  description: string
  currency: FinanceCurrency
  archived: boolean
  createdAt: string
}

/** Whole tree, flattened. The client assembles + computes aggregates live. */
export interface FinanceData {
  resources: FinanceResource[]
  sections: FinanceSection[]
  entries: FinanceEntry[]
}

/* ------------------------------------------------------------------ */
/* Row shapes + mappers                                                */
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
  type: string
  amount: string | number
  status: string
  notes: string
  entry_date: string | Date
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

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function normCurrency(value: string): FinanceCurrency {
  return value === 'RUB' ? 'RUB' : 'USDT'
}

function normType(value: string): FinanceEntryType {
  return value === 'income' ? 'income' : 'expense'
}

function normStatus(value: string): FinanceEntryStatus {
  return FINANCE_ENTRY_STATUSES.includes(value as FinanceEntryStatus)
    ? (value as FinanceEntryStatus)
    : 'planned'
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
    type: normType(row.type),
    amount: Number(row.amount) || 0,
    status: normStatus(row.status),
    notes: row.notes ?? '',
    // entry_date is a DATE — keep the YYYY-MM-DD part only.
    entryDate: iso(row.entry_date).slice(0, 10),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    tasks,
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Load the entire finance tree in a few flat queries. */
export async function getFinanceData(): Promise<FinanceData> {
  const [resourceRows, sectionRows, entryRows, taskRows] = await Promise.all([
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
      `SELECT e.id, e.section_id, e.resource_id, e.title, e.type, e.amount,
              e.status, e.notes, e.entry_date, e.created_at, e.updated_at
         FROM finance_entries e
        ORDER BY e.entry_date DESC, e.created_at DESC`,
    ),
    query<TaskRow>(
      `SELECT t.id, t.entry_id, t.label, t.done, t.sort_order
         FROM finance_entry_tasks t
        ORDER BY t.sort_order ASC, t.created_at ASC`,
    ),
  ])

  const tasksByEntry = new Map<string, FinanceTask[]>()
  for (const row of taskRows) {
    const task = mapTask(row)
    const list = tasksByEntry.get(task.entryId)
    if (list) list.push(task)
    else tasksByEntry.set(task.entryId, [task])
  }

  return {
    resources: resourceRows.map(mapResource),
    sections: sectionRows.map(mapSection),
    entries: entryRows.map((row) => mapEntry(row, tasksByEntry.get(row.id) ?? [])),
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
  // Append to the end of the resource's tab list.
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
/* Entries                                                             */
/* ------------------------------------------------------------------ */

export async function createFinanceEntry(input: {
  sectionId: string
  title: string
  type: FinanceEntryType
  amount: number
  status: FinanceEntryStatus
  notes: string
  entryDate: string
}): Promise<void> {
  // resource_id is derived from the section so it always stays consistent.
  await query(
    `INSERT INTO finance_entries
       (section_id, resource_id, title, type, amount, status, notes, entry_date)
     SELECT s.id, s.resource_id, $2, $3, $4, $5, $6, $7
       FROM finance_sections s
      WHERE s.id = $1`,
    [
      input.sectionId,
      input.title,
      input.type,
      input.amount,
      input.status,
      input.notes,
      input.entryDate,
    ],
  )
}

export async function updateFinanceEntry(
  id: string,
  input: {
    title: string
    type: FinanceEntryType
    amount: number
    status: FinanceEntryStatus
    notes: string
    entryDate: string
  },
): Promise<void> {
  await query(
    `UPDATE finance_entries
        SET title = $2, type = $3, amount = $4, status = $5,
            notes = $6, entry_date = $7, updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.title,
      input.type,
      input.amount,
      input.status,
      input.notes,
      input.entryDate,
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
