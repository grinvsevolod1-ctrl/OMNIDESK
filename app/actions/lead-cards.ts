'use server'

import { revalidatePath } from 'next/cache'
import { getSession, requireAdmin, requireCurator, requireManager } from '@/lib/auth'
import {
  findCuratorsByCity,
  getLeadCardByConversation,
  listLeadCardsForCurator,
  upsertLeadCard,
} from '@/lib/data/lead-cards'

export interface LeadCardActionResult {
  ok: boolean
  message: string
}

/** Manager or admin may fill/transfer a lead card. */
async function requireManagerOrAdmin() {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  if (session.role === 'admin') return session
  if (session.role === 'manager') return session
  throw new Error('Forbidden')
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

  // Admin has no managers-table id — store under a sentinel is not allowed.
  // Admin fills cards only when acting; we require a real manager session for
  // manager_id FK. Admins use god tools separately; for inbox admin views we
  // still need an id. Fall back: admin cannot own cards without a manager row.
  // Practical path: only managers transfer from /app inbox; admin from god panel
  // can pass later. For now if admin, refuse with clear message unless we have
  // a manager sub.
  if (session.role === 'admin') {
    return {
      ok: false,
      message:
        'Карточку лида заполняет менеджер из входящих. Админ видит переданные лиды у кураторов.',
    }
  }

  try {
    const card = await upsertLeadCard({
      conversationId: input.conversationId,
      managerId: session.sub,
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

/** Admin overview: all transferred leads (optional). */
export async function listAllTransferredLeadsAction() {
  await requireAdmin()
  // Reuse curator list pattern via direct query through find — kept simple.
  const { query } = await import('@/lib/db')
  const rows = await query<{ n: string }>(
    `SELECT count(*)::int AS n FROM lead_cards WHERE transferred_at IS NOT NULL`,
  )
  return { total: Number(rows[0]?.n ?? 0) }
}
