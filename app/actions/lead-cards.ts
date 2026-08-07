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
  listArchivedLeadsForCurator,
  listLeadCardsForCurator,
  setLeadArchived,
  listLeadComments,
  listLeadStatusHistory,
  listLeadTransfers,
  transferLeadToCurator,
  updateLeadStatus,
  upsertLeadCard,
  type AllLeadsFilter,
} from '@/lib/data/lead-cards'
import {
  getLeadCardStats,
  listLeadCardsForManager,
  safeDayKey,
  type ManagerLeadFilterStatus,
} from '@/lib/data/lead-stats'
import { enrollConversationAi } from '@/lib/data/ai-assist'
import {
  isFinalLeadStatus,
  isLeadStatus,
  isPastDailyDeadline,
  leadNeedsDailyStatus,
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

  const [comments, transfers, statusHistory] = await Promise.all([
    listLeadComments(leadCardId),
    listLeadTransfers(leadCardId),
    listLeadStatusHistory(leadCardId).catch(() => []),
  ])
  return { card, comments, transfers, statusHistory }
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
    leadNeedsDailyStatus(l),
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
  from?: string | null
  to?: string | null
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
    from: safeDayKey(filter.from),
    to: safeDayKey(filter.to),
    orphanedOnly: Boolean(filter.orphanedOnly),
    limit: filter.limit,
    offset: filter.offset,
  }
  return listAllTransferredLeads(safe)
}

/* ------------------------- Lead-card statistics ------------------------- */

/** Manager: stats over HIS lead cards for a period / single day (MSK). */
export async function getMyLeadCardStatsAction(filter: {
  from?: string | null
  to?: string | null
}) {
  const session = await getSession()
  if (!session || session.role !== 'manager') throw new Error('Forbidden')
  return getLeadCardStats({
    managerId: session.sub,
    from: filter.from ?? null,
    to: filter.to ?? null,
  })
}

/** Manager: HIS lead cards with period + status filters («Передан» etc.). */
export async function listMyLeadCardsAction(filter: {
  from?: string | null
  to?: string | null
  status?: string | null
  limit?: number
  offset?: number
}) {
  const session = await getSession()
  if (!session || session.role !== 'manager') throw new Error('Forbidden')
  const status: ManagerLeadFilterStatus =
    filter.status === 'transferred' ||
    filter.status === 'not_transferred' ||
    filter.status === 'none'
      ? filter.status
      : isLeadStatus(filter.status)
        ? filter.status
        : null
  return listLeadCardsForManager(session.sub, {
    from: filter.from ?? null,
    to: filter.to ?? null,
    status,
    limit: filter.limit,
    offset: filter.offset,
  })
}

/** Admin: lead-card stats by dates, optionally scoped to manager/curator. */
export async function getLeadCardStatsAdminAction(filter: {
  from?: string | null
  to?: string | null
  managerId?: string | null
  curatorId?: string | null
}) {
  await requireAdmin()
  return getLeadCardStats({
    managerId: filter.managerId ?? null,
    curatorId: filter.curatorId ?? null,
    from: filter.from ?? null,
    to: filter.to ?? null,
  })
}

/** Admin: per-curator discipline snapshot for today. */
export async function getCuratorDisciplineAction() {
  await requireAdmin()
  return getCuratorDiscipline()
}

/* --------------------------- Lifecycle (117) --------------------------- */

/** Curator: archived leads of the current curator. */
export async function listMyArchivedLeadsAction() {
  const session = await requireCurator()
  return listArchivedLeadsForCurator(session.sub)
}

/** Curator: archive a final lead / bring it back from the archive. */
export async function setLeadArchivedAction(input: {
  leadCardId: string
  archived: boolean
}): Promise<LeadCardActionResult> {
  const session = await requireCurator()
  try {
    // Archiving is workspace maintenance — the daily gate still applies.
    await assertCuratorNotLocked(session.sub)
    await setLeadArchived({
      leadCardId: input.leadCardId,
      curatorId: session.sub,
      archived: input.archived,
    })
    revalidatePath('/curator')
    revalidatePath('/admin/curators')
    return {
      ok: true,
      message: input.archived ? 'Лид перенесён в архив.' : 'Лид возвращён из архива.',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка архивации'
    return { ok: false, message: msg }
  }
}

/**
 * Return a final lead to the AI funnel: the seller re-enrolls into the
 * original dialog (existing follow-up machinery revives the client), and the
 * card goes to the archive so it leaves the active workspace. Available to
 * the owning curator and to the admin.
 */
export async function returnLeadToFunnelAction(input: {
  leadCardId: string
}): Promise<LeadCardActionResult> {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')

  const card = await getLeadCardById(input.leadCardId)
  if (!card) return { ok: false, message: 'Лид не найден.' }

  const allowed =
    session.role === 'admin' ||
    (session.role === 'curator' && card.curatorId === session.sub)
  if (!allowed) return { ok: false, message: 'Нет доступа к этому лиду.' }

  if (!isFinalLeadStatus(card.status)) {
    return {
      ok: false,
      message:
        'Вернуть в воронку можно только лид с финальным статусом («Отказался» или «Кинул»).',
    }
  }
  if (!card.conversationId) {
    return {
      ok: false,
      message: 'У этого лида нет привязанного диалога — ИИ некуда возвращаться.',
    }
  }

  try {
    const enrolled = await enrollConversationAi(card.conversationId)
    if (!enrolled) {
      return { ok: false, message: 'Не удалось включить ИИ в диалог.' }
    }
    // The card leaves the active workspace; the trail notes who sent it back.
    await query(
      `UPDATE lead_cards
          SET archived_at = COALESCE(archived_at, now()), updated_at = now()
        WHERE id = $1`,
      [card.id],
    )
    await addLeadComment({
      leadCardId: card.id,
      authorId: session.sub,
      body: 'Лид возвращён в работу ИИ-менеджера (реанимация из финального статуса).',
    }).catch(() => null)

    revalidatePath('/curator')
    revalidatePath('/admin/curators')
    return {
      ok: true,
      message: `Лид «${card.fullName || 'без имени'}» возвращён в воронку — ИИ снова ведёт диалог.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка возврата в воронку'
    return { ok: false, message: msg }
  }
}
