'use server'

/**
 * Панель руководителя (/head, role = 'head', миграция 141).
 *
 * Руководитель видит лидов СВОИХ кураторов (head_curators, только переданные)
 * и СВОИХ менеджеров (head_managers, миграция 143). Право на запись — флаг
 * managers.head_can_edit («просмотр и редактирование»), перечитывается из БД
 * на каждый мутирующий запрос (см. assertHeadCanEdit): снятие права админом
 * действует немедленно. Смена кадрового статуса и передача лида — операции
 * над КУРАТОРСКИМИ карточками (requireGroupLead), а правка полей и комментарии
 * менеджерских лидов идут через общий updateLeadFieldAction/comment actions
 * с проверкой canAccessLeadCardAsync (обе группы).
 */
import { requireHead } from '@/lib/auth'
import {
  listCuratorsOfHead,
  listLeadCardsForHead,
  isCuratorOfHead,
} from '@/lib/data/heads'
import {
  adminSetLeadStatus,
  getLeadCardById,
  transferLeadToCurator,
} from '@/lib/data/lead-cards'
import { isLeadStatus, STATUS_COMMENT_MIN_LEN, type LeadStatus } from '@/lib/lead-status'
import {
  assertHeadCanEdit,
  notifyCuratorOfTransfer,
  type LeadCardActionResult,
} from './lead-cards/shared'

/** Head: кураторы моей группы (для фильтра и передачи лидов). */
export async function listMyGroupCuratorsAction() {
  const session = await requireHead()
  return listCuratorsOfHead(session.sub)
}

/** Head: активные лиды всех кураторов моей группы. */
export async function listGroupLeadsAction() {
  const session = await requireHead()
  return listLeadCardsForHead(session.sub)
}

/** Гейт: лид существует и принадлежит куратору моей группы. */
async function requireGroupLead(headId: string, leadCardId: string) {
  const card = await getLeadCardById(leadCardId)
  if (!card || !(await isCuratorOfHead(headId, card.curatorId))) {
    throw new Error('Лид не найден или не входит в вашу группу.')
  }
  return card
}

/** Head (право «редактирование»): смена статуса лида с комментарием. */
export async function headSetLeadStatusAction(input: {
  leadCardId: string
  status: string
  comment: string
}): Promise<LeadCardActionResult> {
  const session = await requireHead()
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
    await assertHeadCanEdit(session.sub)
    await requireGroupLead(session.sub, input.leadCardId)
    // Автор фиксируется снапшотом имени, как у админа: комментарий статуса
    // не притворяется куратором.
    await adminSetLeadStatus({
      leadCardId: input.leadCardId,
      status: input.status as LeadStatus,
      comment: input.comment,
      authorName: `${session.name ?? 'Руководитель'} (руководитель)`,
    })
    return { ok: true, message: 'Статус обновлён.' }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Ошибка обновления',
    }
  }
}

/** Head (право «редактирование»): передача лида другому куратору СВОЕЙ группы. */
export async function headTransferLeadAction(input: {
  leadCardId: string
  toCuratorId: string
}): Promise<LeadCardActionResult> {
  const session = await requireHead()
  try {
    await assertHeadCanEdit(session.sub)
    await requireGroupLead(session.sub, input.leadCardId)
    // Целевой куратор тоже обязан быть в группе руководителя.
    if (!(await isCuratorOfHead(session.sub, input.toCuratorId))) {
      return { ok: false, message: 'Этот куратор не входит в вашу группу.' }
    }
    const card = await transferLeadToCurator(
      input.leadCardId,
      input.toCuratorId,
      { id: session.sub, role: 'head' },
    )
    if (card.curatorId) {
      void notifyCuratorOfTransfer(card.curatorId, card.fullName, card.city)
    }
    return {
      ok: true,
      message: `Лид передан${card.curatorName ? ` менеджеру по кадрам ${card.curatorName}` : ''}.`,
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Ошибка передачи',
    }
  }
}

// Правка полей карточки для руководителя идёт через общий
// updateLeadFieldAction (app/actions/lead-cards/admin.ts) — он знает про
// head-with-edit и группу; inline-редакторы работают без изменений.
