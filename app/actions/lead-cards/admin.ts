'use server'

/**
 * Админские операции над лидами: выборка с фильтрами, передача, корзина,
 * inline-редактирование. Часть распила app/actions/lead-cards.ts.
 */
import { revalidatePath } from 'next/cache'
import { getSession, requireAdmin } from '@/lib/auth'
import {
  adminSetLeadStatus,
  isInlineLeadField,
  listActiveCurators,
  listAllTransferredLeads,
  listDeletedLeads,
  listLeadCardsForCurator,
  restoreLeadCard,
  softDeleteLeadCard,
  transferLeadToCurator,
  updateLeadCardField,
  type AllLeadsFilter,
} from '@/lib/data/lead-cards'
import { safeDayKey } from '@/lib/data/lead-stats'
import { isLeadStatus } from '@/lib/lead-status'
import {
  notifyCuratorOfTransfer,
  type LeadCardActionResult,
} from './shared'

/** Admin: list leads for a specific curator. */
export async function listCuratorLeadsAdminAction(curatorId: string) {
  await requireAdmin()
  return listLeadCardsForCurator(curatorId)
}

export async function listActiveCuratorsAction() {
  const session = await getSession()
  if (!session || (session.role !== 'admin' && session.role !== 'manager')) {
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
    revalidatePath('/admin/curators')
    revalidatePath('/curator')
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
    revalidatePath('/admin/curators')
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
    revalidatePath('/admin/curators')
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
    revalidatePath('/admin/curators')
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
  await requireAdmin()
  if (!isInlineLeadField(input.field)) {
    return { ok: false, message: 'Это поле нельзя редактировать из таблицы' }
  }
  try {
    await updateLeadCardField({
      leadCardId: input.leadCardId,
      field: input.field,
      value: input.value,
    })
    revalidatePath('/admin/curators')
    return { ok: true, message: 'Сохранено' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}
