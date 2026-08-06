'use server'

import { revalidatePath } from 'next/cache'
import { getSession, requireAdmin, requireCurator } from '@/lib/auth'
import { query } from '@/lib/db'
import {
  addLeadComment,
  countLeadsNeedingStatus,
  findCuratorsByCity,
  getCuratorDiscipline,
  getLeadCardByConversation,
  getLeadCardById,
  listActiveCurators,
  listAllTransferredLeads,
  listLeadCardsForCurator,
  listLeadComments,
  listLeadTransfers,
  transferLeadToCurator,
  updateLeadStatus,
  upsertLeadCard,
  type AllLeadsFilter,
} from '@/lib/data/lead-cards'
import {
  isLeadStatus,
  isPastDailyDeadline,
  needsDailyStatusUpdate,
  STATUS_COMMENT_MIN_LEN,
  type LeadStatus,
} from '@/lib/lead-status'
import { sendPushToManager } from '@/lib/push'
import { mskDayKey } from '@/lib/time'

export interface LeadCardActionResult {
  ok: boolean
  message: string
}

async function requireManagerOrAdmin() {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  if (session.role === 'admin') return session
  if (session.role === 'manager') return session
  throw new Error('Forbidden')
}

/**
 * Server-side discipline gate: past the daily deadline a curator with
 * unconfirmed statuses may ONLY confirm statuses. Everything else is refused
 * here — the client overlay is a hint, this is the actual enforcement.
 */
async function assertCuratorNotLocked(curatorId: string): Promise<void> {
  if (!isPastDailyDeadline()) return
  const pending = await countLeadsNeedingStatus(
    curatorId,
    mskDayKey(new Date()),
    true,
  )
  if (pending > 0) {
    throw new Error(
      `Рабочее место ограничено: подтвердите статусы всех лидов (осталось ${pending}).`,
    )
  }
}

async function resolveCardManagerId(
  session: { role: string; sub: string },
  conversationId: string,
): Promise<{ ok: true; managerId: string } | { ok: false; message: string }> {
  if (session.role === 'manager') {
    return { ok: true, managerId: session.sub }
  }

  const rows = await query<{ manager_id: string | null }>(
    `SELECT manager_id FROM conversations WHERE id = $1 LIMIT 1`,
    [conversationId],
  )
  const managerId = rows[0]?.manager_id
  if (!managerId) {
    return {
      ok: false,
      message:
        'У диалога нет назначенного менеджера — нельзя сохранить карточку.',
    }
  }
  return { ok: true, managerId }
}

/** Push the curator about a lead handed to them. Never throws. */
async function notifyCuratorOfTransfer(
  curatorId: string,
  leadName: string,
  city: string,
): Promise<void> {
  try {
    await sendPushToManager(curatorId, {
      title: 'Omnidesk — новый лид',
      body: `Вам передан лид: ${leadName || 'без имени'}${city ? ` (${city})` : ''}. Подтвердите статус.`,
      url: '/curator',
      tag: 'omnidesk-curator-lead',
    })
  } catch {
    /* notification must never break the transfer */
  }
}

export async function getLeadCardAction(conversationId: string) {
  await requireManagerOrAdmin()
  return getLeadCardByConversation(conversationId)
}

export async function findCuratorsByCityAction(city: string) {
  await requireManagerOrAdmin()
  return findCuratorsByCity(city)
}

export async function saveLeadCardAction(input: {
  conversationId: string
  fullName: string
  phone: string
  telegramUsername: string
  city: string
  address: string
  vacancy: string
  curatorId?: string | null
}): Promise<LeadCardActionResult> {
  const session = await requireManagerOrAdmin()

  if (!input.conversationId) {
    return { ok: false, message: 'Диалог не указан.' }
  }
  if (!input.fullName.trim()) {
    return { ok: false, message: 'Укажите ФИО.' }
  }
  if (!input.city.trim()) {
    return { ok: false, message: 'Укажите город.' }
  }
  if (input.curatorId && !input.curatorId.trim()) {
    return { ok: false, message: 'Выберите куратора.' }
  }

  const resolved = await resolveCardManagerId(session, input.conversationId)
  if (!resolved.ok) return resolved

  try {
    const { card, transferred, duplicateWarning } = await upsertLeadCard({
      conversationId: input.conversationId,
      managerId: resolved.managerId,
      fullName: input.fullName,
      phone: input.phone,
      telegramUsername: input.telegramUsername,
      city: input.city,
      address: input.address,
      vacancy: input.vacancy,
      curatorId: input.curatorId ?? null,
      isAdmin: session.role === 'admin',
    })
    revalidatePath('/app/inbox')
    revalidatePath('/curator')
    revalidatePath('/admin/curators')

    if (transferred && card.curatorId) {
      void notifyCuratorOfTransfer(card.curatorId, card.fullName, card.city)
    }

    const warn = duplicateWarning ? ` ${duplicateWarning}` : ''
    if (transferred) {
      return {
        ok: true,
        message: `Лид передан куратору${card.curatorName ? ` ${card.curatorName}` : ''}.${warn}`,
      }
    }
    return { ok: true, message: `Карточка сохранена.${warn}` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка сохранения'
    return { ok: false, message: msg }
  }
}

export async function listMyCuratorLeadsAction() {
  const session = await requireCurator()
  return listLeadCardsForCurator(session.sub)
}

export async function getLeadCardDetailAction(leadCardId: string) {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')

  const card = await getLeadCardById(leadCardId)
  if (!card) return null

  const allowed =
    session.role === 'admin' ||
    (session.role === 'curator' && card.curatorId === session.sub) ||
    // The manager who owns the card may read its history too.
    (session.role === 'manager' && card.managerId === session.sub)
  if (!allowed) throw new Error('Forbidden')

  const [comments, transfers] = await Promise.all([
    listLeadComments(leadCardId),
    listLeadTransfers(leadCardId),
  ])
  return { card, comments, transfers }
}

export async function updateLeadStatusAction(input: {
  leadCardId: string
  status: string
  comment: string
}): Promise<LeadCardActionResult> {
  const session = await requireCurator()
  if (!isLeadStatus(input.status)) {
    return { ok: false, message: 'Выберите корректный статус.' }
  }
  if (input.comment.trim().length < STATUS_COMMENT_MIN_LEN) {
    return {
      ok: false,
      message: `Комментарий — минимум ${STATUS_COMMENT_MIN_LEN} символов.`,
    }
  }
  try {
    await updateLeadStatus({
      leadCardId: input.leadCardId,
      curatorId: session.sub,
      status: input.status as LeadStatus,
      comment: input.comment,
    })
    revalidatePath('/curator')
    revalidatePath('/admin/curators')
    return { ok: true, message: 'Статус обновлён.' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка обновления'
    return { ok: false, message: msg }
  }
}

export async function addLeadCommentAction(input: {
  leadCardId: string
  body: string
}): Promise<LeadCardActionResult> {
  const session = await requireCurator()
  if (input.body.trim().length < 1) {
    return { ok: false, message: 'Введите комментарий.' }
  }
  const card = await getLeadCardById(input.leadCardId)
  if (!card || card.curatorId !== session.sub) {
    return { ok: false, message: 'Лид не найден.' }
  }
  try {
    // Free comments are part of the restricted workspace: confirm statuses first.
    await assertCuratorNotLocked(session.sub)
    await addLeadComment({
      leadCardId: input.leadCardId,
      authorId: session.sub,
      body: input.body,
    })
    revalidatePath('/curator')
    return { ok: true, message: 'Комментарий добавлен.' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка'
    return { ok: false, message: msg }
  }
}

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
      message: `Лид передан${card.curatorName ? ` куратору ${card.curatorName}` : ''}.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка передачи'
    return { ok: false, message: msg }
  }
}

/** Curator daily gate payload (used by the workspace to re-check live). */
export async function getCuratorStatusGateAction() {
  const session = await requireCurator()
  const leads = await listLeadCardsForCurator(session.sub)
  const pending = leads.filter((l) =>
    needsDailyStatusUpdate(l.statusConfirmedDate),
  )
  return {
    total: leads.length,
    pendingCount: pending.length,
    pendingIds: pending.map((l) => l.id),
    locked: isPastDailyDeadline() && pending.length > 0,
    today: mskDayKey(new Date()),
  }
}

/** Admin: all transferred leads with filters (incl. orphaned ones). */
export async function listAllLeadsAdminAction(filter: {
  curatorId?: string | null
  status?: string | null
  city?: string | null
  orphanedOnly?: boolean
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
    orphanedOnly: Boolean(filter.orphanedOnly),
    limit: filter.limit,
    offset: filter.offset,
  }
  return listAllTransferredLeads(safe)
}

/** Admin: per-curator discipline snapshot for today. */
export async function getCuratorDisciplineAction() {
  await requireAdmin()
  return getCuratorDiscipline()
}
