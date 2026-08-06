'use server'

import { revalidatePath } from 'next/cache'
import { getSession, requireAdmin, requireCurator } from '@/lib/auth'
import { query } from '@/lib/db'
import {
  addLeadComment,
  findCuratorsByCity,
  getLeadCardByConversation,
  getLeadCardById,
  listActiveCurators,
  listLeadCardsForCurator,
  listLeadComments,
  transferLeadToCurator,
  updateLeadStatus,
  upsertLeadCard,
} from '@/lib/data/lead-cards'
import {
  isLeadStatus,
  needsDailyStatusUpdate,
  STATUS_COMMENT_MIN_LEN,
  type LeadStatus,
} from '@/lib/lead-status'
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
    const card = await upsertLeadCard({
      conversationId: input.conversationId,
      managerId: resolved.managerId,
      fullName: input.fullName,
      phone: input.phone,
      telegramUsername: input.telegramUsername,
      city: input.city,
      address: input.address,
      vacancy: input.vacancy,
      curatorId: input.curatorId ?? null,
    })
    revalidatePath('/app/inbox')
    revalidatePath('/curator')
    revalidatePath('/admin/curators')
    if (card.transferredAt) {
      return {
        ok: true,
        message: `Лид передан куратору${card.curatorName ? ` ${card.curatorName}` : ''}.`,
      }
    }
    return { ok: true, message: 'Карточка сохранена.' }
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

  if (session.role === 'curator' && card.curatorId !== session.sub) {
    throw new Error('Forbidden')
  }
  if (session.role !== 'admin' && session.role !== 'curator') {
    throw new Error('Forbidden')
  }

  const comments = await listLeadComments(leadCardId)
  return { card, comments }
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
    return {
      ok: true,
      message: `Лид передан${card.curatorName ? ` куратору ${card.curatorName}` : ''}.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка передачи'
    return { ok: false, message: msg }
  }
}

/** Curator daily gate payload. */
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
    today: mskDayKey(new Date()),
  }
}

export async function listAllTransferredLeadsAction() {
  await requireAdmin()
  const rows = await query<{ n: string }>(
    `SELECT count(*)::int AS n FROM lead_cards WHERE transferred_at IS NOT NULL`,
  )
  return { total: Number(rows[0]?.n ?? 0) }
}
