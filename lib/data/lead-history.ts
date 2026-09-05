/**
 * История карточек лидов: журнал статусов и журнал передач между
 * менеджерами по кадрам. Вынесено из lead-cards.ts (распил монолита);
 * все записи — со снапшотами имён, чтобы удаление аккаунта не рвало историю.
 */
import { randomUUID } from 'crypto'
import { query, type DbExecutor } from '../db'
import { isLeadStatus, type LeadStatus } from '../lead-status'
import { sendPushToManager } from '../push'
import type { LeadTransfer } from './lead-cards-core'

/** Человекочитаемое имя канала для тела push-уведомления. */
function channelLabelForPush(type: string | null): string {
  switch (type) {
    case 'whatsapp':
      return 'WhatsApp'
    case 'telegram':
      return 'Telegram'
    case 'livechat':
      return 'Онлайн-чат'
    case 'max':
      return 'MAX'
    case 'vk':
      return 'VK'
    default:
      return 'Диалог'
  }
}

/**
 * Push «вам передан диалог» менеджеру по кадрам (куратору) в момент ПЕРЕДАЧИ
 * лида — до того, как клиент напишет следующее сообщение. Диспетчер
 * (lib/push-dispatcher.ts) шлёт push только на ВХОДЯЩЕЕ сообщение, поэтому без
 * этого хука куратор узнавал о переданном лиде лишь при следующем ответе
 * клиента (а часто — вообще пропускал). Уведомление несёт conversationId +
 * replyRole:'curator', так что с телефона можно ответить прямо из шторки
 * (см. public/sw.js + app/api/push/reply). Лиды без диалога
 * (conversation_id IS NULL) не трогаем. Строго best-effort: сбой доставки
 * НИКОГДА не должен ломать передачу.
 */
export async function notifyCuratorTransferred(
  leadCardId: string,
  curatorId: string,
): Promise<void> {
  try {
    const rows = await query<{
      conversation_id: string | null
      contact_name: string | null
      contact_handle: string | null
      channel_type: string | null
    }>(
      `SELECT c.id AS conversation_id, c.contact_name, c.contact_handle,
              c.channel_type
         FROM lead_cards lc
         JOIN conversations c ON c.id = lc.conversation_id
        WHERE lc.id = $1`,
      [leadCardId],
    )
    const row = rows[0]
    if (!row?.conversation_id) return
    const who =
      row.contact_name?.trim() || row.contact_handle?.trim() || 'Новый контакт'
    await sendPushToManager(curatorId, {
      title: 'Вам передан диалог',
      body: `${who} · ${channelLabelForPush(row.channel_type)}`,
      url: '/curator/chats',
      // Один пузырёк на диалог: последующие входящие с тем же тегом заменят его.
      tag: `conv:${row.conversation_id}`,
      // Включает инлайн-ответ из уведомления под ролью куратора.
      conversationId: row.conversation_id,
      replyRole: 'curator',
    })
  } catch {
    /* best-effort: передача важнее уведомления */
  }
}

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
    initiatedByRole: 'manager' | 'admin' | 'curator' | 'head'
  },
  db?: DbExecutor,
): Promise<void> {
  const exec = db ?? { query }
  const run = async () => {
    await exec.query(
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
    // Раздел «Чаты» куратора (миграция 151): вслед за передачей ЛИДА привязываем
    // его ДИАЛОГ к тому же куратору — единый chokepoint для всех путей передачи
    // (прямая передача менеджером, захват из пула, передача между кураторами,
    // переназначение админом). Диалог остаётся во владении менеджера; у куратора
    // появляется параллельная ссылка curator_id, ИИ менеджера ставится на паузу.
    // Лиды без диалога (conversation_id IS NULL) просто не затрагиваются.
    await exec.query(
      `UPDATE conversations c
          SET curator_id = $2,
              transferred_to_curator_at = now(),
              ai_paused = true
         FROM lead_cards lc
        WHERE lc.id = $1
          AND lc.conversation_id = c.id`,
      [input.leadCardId, input.toCuratorId],
    )
  }
  if (db) {
    // See recordStatusHistory: inside a transaction errors must propagate.
    // The pickup push is fired by the transactional callers AFTER commit (so a
    // rollback can't emit a spurious "вам передан диалог"), not here.
    await run()
    return
  }
  try {
    await run()
    // Non-transactional path (autocommit already persisted the link above):
    // safe to notify the receiving curator right now.
    void notifyCuratorTransferred(input.leadCardId, input.toCuratorId)
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
