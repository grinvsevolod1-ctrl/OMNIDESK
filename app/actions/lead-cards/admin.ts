'use server'

/**
 * Админские операции над лидами: выборка с фильтрами, передача, корзина,
 * inline-редактирование. Часть распила app/actions/lead-cards.ts.
 */
import { getSession, requireAdmin } from '@/lib/auth'
import {
  adminSetLeadStatus,
  getLeadCardById,
  hardDeleteLeadCard,
  isInlineLeadField,
  listActiveCurators,
  listAllTransferredLeads,
  listArchivedLeadsAdmin,
  listDeletedLeads,
  listLeadCardsForCurator,
  restoreLeadCard,
  setLeadArchived,
  softDeleteLeadCard,
  transferLeadToCurator,
  updateLeadCardField,
  type AllLeadsFilter,
} from '@/lib/data/lead-cards'
import { createLeadNotification } from '@/lib/data/lead-notifications'
import { safeDayKey } from '@/lib/data/lead-stats'
import { isLeadStatus } from '@/lib/lead-status'
import { sendPushToManager } from '@/lib/push'
import {
  assertCuratorNotLocked,
  assertHeadCanEdit,
  canAccessLeadCard,
  canAccessLeadCardAsync,
  notifyCuratorOfTransfer,
  type LeadCardActionResult,
} from './shared'

/** Admin: list leads for a specific curator. */
export async function listCuratorLeadsAdminAction(curatorId: string) {
  await requireAdmin()
  return listLeadCardsForCurator(curatorId)
}

export async function listActiveCuratorsAction() {
  // Менеджеру по кадрам список коллег нужен для передачи своих лидов.
  const session = await getSession()
  if (
    !session ||
    (session.role !== 'admin' &&
      session.role !== 'manager' &&
      session.role !== 'curator')
  ) {
    throw new Error('Forbidden')
  }
  return listActiveCurators()
}

export async function transferLeadAdminAction(input: {
  leadCardId: string
  curatorId: string
}): Promise<LeadCardActionResult> {
  await requireAdmin()
  try {
    const card = await transferLeadToCurator(input.leadCardId, input.curatorId)
    if (card.curatorId) {
      void notifyCuratorOfTransfer(card.curatorId, card.fullName, card.city)
    }
    return {
      ok: true,
      message: `Лид передан${card.curatorName ? ` менеджеру по кадрам ${card.curatorName}` : ''}.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка передачи'
    return { ok: false, message: msg }
  }
}

/** Admin: all transferred leads with filters (incl. orphaned ones). */
export async function listAllLeadsAdminAction(filter: {
  curatorId?: string | null
  status?: string | null
  city?: string | null
  from?: string | null
  to?: string | null
  orphanedOnly?: boolean
  archivedOnly?: boolean
  search?: string | null
  sort?: 'newest' | 'oldest'
  limit?: number
  offset?: number
}) {
  await requireAdmin()
  const safe: AllLeadsFilter = {
    curatorId: filter.curatorId ?? null,
    status:
      filter.status === 'none'
        ? 'none'
        : isLeadStatus(filter.status)
          ? filter.status
          : null,
    city: filter.city ?? null,
    from: safeDayKey(filter.from),
    to: safeDayKey(filter.to),
    orphanedOnly: Boolean(filter.orphanedOnly),
    archivedOnly: Boolean(filter.archivedOnly),
    search: filter.search?.slice(0, 200) ?? null,
    sort: filter.sort === 'oldest' ? 'oldest' : 'newest',
    limit: filter.limit,
    offset: filter.offset,
  }
  return listAllTransferredLeads(safe)
}

/* --------------------- Корзина и inline-редактирование --------------------- */

/** Admin: мягкое удаление лида с обязательной причиной (в корзину). */
export async function softDeleteLeadAction(input: {
  leadCardId: string
  reason: string
}): Promise<LeadCardActionResult> {
  const session = await requireAdmin()
  try {
    // Админ живёт вне таблицы managers (sub = 'admin') — FK хранит NULL,
    // имя уходит снапшотом в историю.
    await softDeleteLeadCard({
      leadCardId: input.leadCardId,
      reason: input.reason,
      deletedById: session.sub === 'admin' ? null : session.sub,
      deletedByName: session.name ?? null,
    })
    return { ok: true, message: 'Лид перемещён в корзину' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}

/** Admin: восстановление лида из корзины. */
export async function restoreLeadAction(
  leadCardId: string,
): Promise<LeadCardActionResult> {
  const session = await requireAdmin()
  try {
    await restoreLeadCard({
      leadCardId,
      restoredById: session.sub === 'admin' ? null : session.sub,
      restoredByName: session.name ?? null,
    })
    return { ok: true, message: 'Лид восстановлен' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}

/** Admin: список корзины (удалённые лиды, автоочистка через 30 дней). */
export async function listTrashAction() {
  await requireAdmin()
  return listDeletedLeads()
}

/* ------------------------------- Архив (админ) ------------------------------ */

/** Admin: архив лидов (ушедшие из активного рабочего места), свежие сверху. */
export async function listArchivedLeadsAdminAction() {
  await requireAdmin()
  return listArchivedLeadsAdmin()
}

/**
 * Admin: вернуть лид из архива обратно его менеджеру по кадрам. Лид снова
 * попадает в активное рабочее место куратора, а куратор получает модальное
 * уведомление с обязательным пояснением, ПОЧЕМУ лид вернулся. Уведомление
 * дублируется web-push'ем (best-effort).
 */
export async function returnArchivedLeadToCuratorAction(input: {
  leadCardId: string
  reason: string
}): Promise<LeadCardActionResult> {
  const session = await requireAdmin()
  const reason = input.reason.replace(/\s+/g, ' ').trim()
  if (reason.length < 3) {
    return { ok: false, message: 'Укажите причину возврата (минимум 3 символа).' }
  }

  const card = await getLeadCardById(input.leadCardId)
  if (!card) return { ok: false, message: 'Лид не найден.' }
  if (!card.archivedAt) {
    return { ok: false, message: 'Этот лид не в архиве.' }
  }
  if (!card.curatorId) {
    return {
      ok: false,
      message:
        'У лида нет менеджера по кадрам — сначала передайте его сотруднику, потом возвращайте.',
    }
  }

  try {
    // Возврат из архива: карточка снова в активном рабочем месте куратора.
    await setLeadArchived({
      leadCardId: card.id,
      curatorId: null, // админ — без проверки владельца
      archived: false,
      actorId: session.sub === 'admin' ? null : session.sub,
      actorName: session.name ?? 'Администратор',
    })

    const leadName = card.fullName || 'без имени'
    // In-app модалка у куратора (главное требование) + web-push страховкой.
    await createLeadNotification({
      recipientId: card.curatorId,
      leadCardId: card.id,
      kind: 'lead_returned_from_archive',
      title: 'Лид возвращён из архива',
      body: reason,
      leadName: card.fullName || null,
    }).catch(() => null)
    void sendPushToManager(card.curatorId, {
      title: 'Omnidesk — лид возвращён из архива',
      body: `${leadName}: ${reason}`,
      url: '/curator',
      tag: 'omnidesk-curator-return',
    }).catch(() => null)

    return {
      ok: true,
      message: `Лид «${leadName}» возвращён менеджеру по кадрам${card.curatorName ? ` ${card.curatorName}` : ''}.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка возврата из архива'
    return { ok: false, message: msg }
  }
}

/**
 * Admin: НЕОБРАТИМОЕ удаление лида. Физически стирает карточку и все связанные
 * записи (комментарии, история, передачи, вложения — ON DELETE CASCADE)
 * независимо от состояния лида. Нужно, чтобы можно было снести «глюченный»
 * лид, который не удаляется обычным мягким удалением.
 */
export async function hardDeleteLeadAction(input: {
  leadCardId: string
}): Promise<LeadCardActionResult> {
  await requireAdmin()
  try {
    const removed = await hardDeleteLeadCard(input.leadCardId)
    if (!removed) return { ok: false, message: 'Лид не найден.' }
    return { ok: true, message: 'Лид удалён навсегда.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}

/** Admin: смена статуса + комментарий из строки таблицы (любой лид). */
export async function adminSetLeadStatusAction(input: {
  leadCardId: string
  status: string
  comment: string
}): Promise<LeadCardActionResult> {
  const session = await requireAdmin()
  if (!isLeadStatus(input.status)) {
    return { ok: false, message: 'Некорректный статус' }
  }
  try {
    await adminSetLeadStatus({
      leadCardId: input.leadCardId,
      status: input.status,
      comment: input.comment,
      authorName: session.name ?? 'Администратор',
    })
    return { ok: true, message: 'Статус обновлён' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}

/** Admin: обновление одного поля лида прямо из строки таблицы. */
export async function updateLeadFieldAction(input: {
  leadCardId: string
  field: string
  value: string
}): Promise<LeadCardActionResult> {
  // Редактировать поля карточки может админ, менеджер по кадрам-владелец
  // ЛИБО руководитель группы этого куратора с правом «редактирование»
  // (передача другому сотруднику — по-прежнему отдельные actions).
  const session = await getSession()
  if (!session) return { ok: false, message: 'Не авторизован' }
  if (session.role !== 'admin') {
    if (session.role === 'curator') {
      const card = await getLeadCardById(input.leadCardId)
      if (!card || !canAccessLeadCard(session, card)) {
        return { ok: false, message: 'Это не ваш лид' }
      }
      try {
        await assertCuratorNotLocked(session.sub)
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
      }
    } else if (session.role === 'head') {
      const card = await getLeadCardById(input.leadCardId)
      // Карточка входит в группу, если её куратор ИЛИ её менеджер — подчинённые.
      if (!card || !(await canAccessLeadCardAsync(session, card))) {
        return { ok: false, message: 'Лид не входит в вашу группу' }
      }
      try {
        await assertHeadCanEdit(session.sub)
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
      }
    } else {
      return { ok: false, message: 'Нет доступа' }
    }
  }
  if (!isInlineLeadField(input.field)) {
    return { ok: false, message: 'Это поле нельзя редактировать из таблицы' }
  }
  try {
    await updateLeadCardField({
      leadCardId: input.leadCardId,
      field: input.field,
      value: input.value,
    })
    return { ok: true, message: 'Сохранено' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}
