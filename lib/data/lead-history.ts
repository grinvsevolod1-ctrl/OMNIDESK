/**
 * История карточек лидов: журнал статусов и журнал передач между
 * менеджерами по кадрам. Вынесено из lead-cards.ts (распил монолита);
 * все записи — со снапшотами имён, чтобы удаление аккаунта не рвало историю.
 */
import { randomUUID } from 'crypto'
import { query, type DbExecutor } from '../db'
import { isLeadStatus, type LeadStatus } from '../lead-status'
import type { LeadTransfer } from './lead-cards-core'

/**
 * Типы событий в журнале. Помимо подтверждений статуса журнал хранит события
 * жизненного цикла: удаление в корзину / восстановление (админ) и
 * архив / возврат из архива (менеджер по кадрам или админ) — чтобы в истории
 * было видно, ЧТО именно сделали, а не только дату и имя.
 */
export type LeadHistoryReason =
  | 'confirm'
  | 'transfer_reset'
  | 'deleted'
  | 'restored'
  | 'archived'
  | 'unarchived'

export interface LeadStatusHistoryEntry {
  id: string
  status: LeadStatus | null
  curatorName: string | null
  reason: LeadHistoryReason
  /** Пояснение события (например, причина удаления в корзину). */
  note: string | null
  createdAt: string
}

/** Record one status-history event. Never throws outside a transaction. */
export async function recordStatusHistory(
  input: {
    leadCardId: string
    curatorId: string | null
    status: LeadStatus | null
    reason: LeadHistoryReason
    /**
     * Снапшот имени актора. Если не передан — берётся из managers по id.
     * Нужен для админа: он живёт вне таблицы managers (FK хранит NULL).
     */
    actorName?: string | null
  },
  db?: DbExecutor,
): Promise<void> {
  const run = () =>
    (db ?? { query }).query(
      `INSERT INTO lead_status_history (lead_card_id, curator_id, curator_name, status, reason)
       VALUES ($1, $2, COALESCE($5, (SELECT name FROM managers WHERE id = $2)), $3, $4)`,
      [
        input.leadCardId,
        input.curatorId,
        input.status,
        input.reason,
        input.actorName ?? null,
      ],
    )
  if (db) {
    // Inside a transaction errors MUST propagate: a swallowed failure leaves
    // the tx aborted (COMMIT would fail anyway), and атомарность «статус +
    // история» — ровно то, ради чего транзакция и нужна.
    await run()
    return
  }
  try {
    await run()
  } catch {
    /* best-effort outside transactions: history must not break the write */
  }
}

export async function listLeadStatusHistory(
  leadCardId: string,
): Promise<LeadStatusHistoryEntry[]> {
  const rows = await query<{
    id: string
    status: string | null
    curator_name: string | null
    reason: string
    created_at: string | Date
  }>(
    `SELECT id, status, curator_name, reason, created_at
       FROM lead_status_history
      WHERE lead_card_id = $1
      ORDER BY created_at DESC
      LIMIT 100`,
    [leadCardId],
  )
  return rows.map((r) => {
    // Удаление хранится как 'deleted: <причина>' — вынимаем причину в note.
    let reason: LeadHistoryReason = 'confirm'
    let note: string | null = null
    if (r.reason === 'transfer_reset') reason = 'transfer_reset'
    else if (r.reason.startsWith('deleted')) {
      reason = 'deleted'
      note = r.reason.slice('deleted'.length).replace(/^:\s*/, '').trim() || null
    } else if (r.reason === 'restored') reason = 'restored'
    else if (r.reason === 'archived') reason = 'archived'
    else if (r.reason === 'unarchived') reason = 'unarchived'
    return {
      id: r.id,
      status: isLeadStatus(r.status) ? r.status : null,
      curatorName: r.curator_name,
      reason,
      note,
      createdAt: new Date(r.created_at).toISOString(),
    }
  })
}

/** Record one transfer event with name snapshots. Never throws outside a tx. */
export async function recordTransfer(
  input: {
    leadCardId: string
    fromCuratorId: string | null
    toCuratorId: string
    initiatedById: string | null
    initiatedByRole: 'manager' | 'admin'
  },
  db?: DbExecutor,
): Promise<void> {
  const run = () =>
    (db ?? { query }).query(
      `INSERT INTO lead_transfers
         (id, lead_card_id, from_curator_id, to_curator_id,
          from_curator_name, to_curator_name, initiated_by, initiated_by_role)
       VALUES ($1, $2, $3, $4,
               (SELECT name FROM managers WHERE id = $3),
               (SELECT name FROM managers WHERE id = $4),
               $5, $6)`,
      [
        randomUUID(),
        input.leadCardId,
        input.fromCuratorId,
        input.toCuratorId,
        input.initiatedById,
        input.initiatedByRole,
      ],
    )
  if (db) {
    // See recordStatusHistory: inside a transaction errors must propagate.
    await run()
    return
  }
  try {
    await run()
  } catch {
    /* best-effort outside transactions: history must not break the transfer */
  }
}

export async function listLeadTransfers(
  leadCardId: string,
): Promise<LeadTransfer[]> {
  const rows = await query<{
    id: string
    lead_card_id: string
    from_curator_name: string | null
    to_curator_name: string | null
    initiated_by_role: string
    created_at: string | Date
  }>(
    `SELECT id, lead_card_id, from_curator_name, to_curator_name,
            initiated_by_role, created_at
       FROM lead_transfers
      WHERE lead_card_id = $1
      ORDER BY created_at DESC`,
    [leadCardId],
  )
  return rows.map((r) => ({
    id: r.id,
    leadCardId: r.lead_card_id,
    fromCuratorName: r.from_curator_name,
    toCuratorName: r.to_curator_name,
    initiatedByRole: r.initiated_by_role,
    createdAt: new Date(r.created_at).toISOString(),
  }))
}
