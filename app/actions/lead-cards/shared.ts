/**
 * Общие (не-action) хелперы server actions карточек лидов.
 * Живут отдельно от 'use server'-модулей: туда можно экспортировать только
 * async server functions, а здесь — синхронные утилиты и типы.
 */
import 'server-only'

import { getSession } from '@/lib/auth'
import { query } from '@/lib/db'
import { countLeadsNeedingStatus } from '@/lib/data/lead-cards'
import type { LeadAttachment } from '@/lib/data/lead-attachments'
import { isPastDailyDeadline } from '@/lib/lead-status'
import { sendPushToManager } from '@/lib/push'
import { mskDayKey } from '@/lib/time'

export interface LeadCardActionResult {
  ok: boolean
  message: string
}

/** Вложение + серверный флаг «можно удалить» (автор или админ). */
export type LeadAttachmentView = LeadAttachment & { canDelete: boolean }

export function withCanDelete(
  session: { role: string; sub: string },
  list: LeadAttachment[],
): LeadAttachmentView[] {
  return list.map((a) => ({
    ...a,
    canDelete: session.role === 'admin' || a.authorId === session.sub,
  }))
}

export async function requireManagerOrAdmin() {
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
export async function assertCuratorNotLocked(curatorId: string): Promise<void> {
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

export async function resolveCardManagerId(
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
export async function notifyCuratorOfTransfer(
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

/** true, когда сессия имеет доступ к карточке (админ / её менеджер по кадрам / её менеджер). */
export function canAccessLeadCard(
  session: { role: string; sub: string },
  card: { curatorId: string | null; managerId: string | null },
): boolean {
  return (
    session.role === 'admin' ||
    (session.role === 'curator' && card.curatorId === session.sub) ||
    (session.role === 'manager' && card.managerId === session.sub)
  )
}

/**
 * Асинхронный вариант canAccessLeadCard, знающий про руководителей: head
 * имеет доступ к карточке, если её куратор ЛИБО её менеджер входит в его
 * группу (head_curators / head_managers). Право на ЗАПИСЬ у head дополнительно
 * требует managers.head_can_edit — проверяется отдельно через assertHeadCanEdit.
 */
export async function canAccessLeadCardAsync(
  session: { role: string; sub: string },
  card: { curatorId: string | null; managerId: string | null },
): Promise<boolean> {
  if (canAccessLeadCard(session, card)) return true
  if (session.role !== 'head') return false
  const { isCuratorOfHead, isManagerOfHead } = await import('@/lib/data/heads')
  if (await isCuratorOfHead(session.sub, card.curatorId)) return true
  return isManagerOfHead(session.sub, card.managerId)
}

/**
 * Гейт записи для руководителя: право «просмотр и редактирование»
 * (managers.head_can_edit) перечитывается из БД на каждый запрос — снятие
 * права админом действует немедленно, не дожидаясь перевыпуска сессии.
 */
export async function assertHeadCanEdit(headId: string): Promise<void> {
  const rows = await query<{ head_can_edit: boolean }>(
    `SELECT head_can_edit FROM managers
      WHERE id = $1 AND role = 'head' LIMIT 1`,
    [headId],
  )
  if (!rows[0]?.head_can_edit) {
    throw new Error('У вас право только на просмотр. Обратитесь к администратору.')
  }
}
