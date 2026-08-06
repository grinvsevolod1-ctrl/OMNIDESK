'use server'

import { revalidatePath } from 'next/cache'
import { getSession, requireAdmin, requireCurator } from '@/lib/auth'
import { query } from '@/lib/db'
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

/**
 * Resolve the managers.id that owns the card.
 * Manager session → session.sub.
 * Admin session → conversation's assigned manager (FK requires a real row).
 */
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
  const rows = await query<{ n: string }>(
    `SELECT count(*)::int AS n FROM lead_cards WHERE transferred_at IS NOT NULL`,
  )
  return { total: Number(rows[0]?.n ?? 0) }
}
