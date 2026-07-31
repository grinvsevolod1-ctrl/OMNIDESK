/**
 * Finance resources, sections, expense entries and their task checklists (CRUD).
 */

import {
  query,
} from '../db'
import {
  type FinanceCurrency,
  type FinanceEntryStatus,
  type FinanceResource,
  type FinanceSection,
  type FinanceTask,
} from '../finance-types'
import {
  mapResource,
  mapSection,
  mapTask,
  type ResourceRow,
  type SectionRow,
  type TaskRow,
} from './rows'

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
  /** Сумма в USD (уже сконвертирована). */
  amount: number
  /** Исходная сумма в валюте ввода. */
  origAmount: number
  /** Валюта ввода. */
  origCurrency: FinanceCurrency
  /** Курс USD за 1 единицу origCurrency на момент добавления. */
  fxRate: number
  status: FinanceEntryStatus
  notes: string
  entryDate: string
  dueDate: string | null
}): Promise<void> {
  // resource_id is derived from the section so it always stays consistent.
  await query(
    `INSERT INTO finance_entries
       (section_id, resource_id, title, vendor, type, amount,
        orig_amount, orig_currency, fx_rate, status, notes,
        entry_date, due_date)
     SELECT s.id, s.resource_id, $2, $3, 'expense', $4,
            $5, $6, $7, $8, $9, $10, $11
       FROM finance_sections s
      WHERE s.id = $1`,
    [
      input.sectionId,
      input.title,
      input.vendor,
      input.amount,
      input.origAmount,
      input.origCurrency,
      input.fxRate,
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
    origAmount: number
    origCurrency: FinanceCurrency
    fxRate: number
    status: FinanceEntryStatus
    notes: string
    entryDate: string
    dueDate: string | null
  },
): Promise<void> {
  await query(
    `UPDATE finance_entries
        SET title = $2, vendor = $3, amount = $4,
            orig_amount = $5, orig_currency = $6, fx_rate = $7,
            status = $8, notes = $9, entry_date = $10, due_date = $11,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.title,
      input.vendor,
      input.amount,
      input.origAmount,
      input.origCurrency,
      input.fxRate,
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
