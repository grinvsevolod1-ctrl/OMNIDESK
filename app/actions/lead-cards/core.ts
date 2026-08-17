'use server'

/**
 * Карточка лида: чтение, сохранение/передача, статусы и комментарии.
 * Часть распила app/actions/lead-cards.ts.
 *
 * Здесь НЕТ revalidatePath: все дашборды рендерятся динамически (cookie-auth),
 * а клиенты сами обновляют состояние через refresh()/mutate после action —
 * серверный ре-рендер страницы был бы третьим, выбрасываемым запросом.
 */
import { getSession, requireCurator } from '@/lib/auth'
import {
  addLeadComment,
  findCuratorsByCity,
  findLeadCardForContact,
  getLeadCardByConversation,
  getLeadCardById,
  listLeadCardsForCurator,
  listLeadComments,
  listLeadStatusHistory,
  listLeadTransfers,
  transferLeadToCurator,
  updateLeadStatus,
  upsertLeadCard,
} from '@/lib/data/lead-cards'
import { listLeadAttachments } from '@/lib/data/lead-attachments'
import {
  isLeadStatus,
  leadStatusLabel,
  STATUS_COMMENT_MIN_LEN,
  type LeadStatus,
} from '@/lib/lead-status'
import { sendPushToManager } from '@/lib/push'
import {
  assertCuratorNotLocked,
  assertHeadCanEdit,
  canAccessLeadCardAsync,
  notifyCuratorOfTransfer,
  requireManagerOrAdmin,
  resolveCardManagerId,
  withCanDelete,
  type LeadCardActionResult,
} from './shared'

export async function getLeadCardAction(conversationId: string) {
  await requireManagerOrAdmin()
  // Сначала карточка этого диалога; если её нет — карточка того же контакта
  // из другого диалога (человек написал на другой наш аккаунт): панель
  // откроется уже заполненной, дубль не создаётся.
  const own = await getLeadCardByConversation(conversationId)
  if (own) return own
  return findLeadCardForContact(conversationId).catch(() => null)
}

export async function findCuratorsByCityAction(city: string) {
  await requireManagerOrAdmin()
  return findCuratorsByCity(city)
}

/**
 * Менеджер по кадрам передаёт СВОЙ лид коллеге. Владение проверяется в
 * transferLeadToCurator под row-lock (гонка двух передач исключена), статус
 * сбрасывается — новый владелец подтверждает его как обычно. Дисциплина:
 * после дедлайна с неподтверждёнными статусами передача недоступна.
 */
export async function transferMyLeadAction(input: {
  leadCardId: string
  toCuratorId: string
}): Promise<LeadCardActionResult> {
  const session = await requireCurator()
  if (input.toCuratorId === session.sub) {
    return { ok: false, message: 'Нельзя передать лид самому себе.' }
  }
  try {
    await assertCuratorNotLocked(session.sub)
    const card = await transferLeadToCurator(
      input.leadCardId,
      input.toCuratorId,
      {
        id: session.sub,
        role: 'curator',
        requireOwnerId: session.sub,
      },
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

export async function saveLeadCardAction(input: {
  conversationId: string
  fullName: string
  phone: string
  telegramUsername: string
  /** Числовой Telegram ID — отдельное поле, не подменяет телефон. */
  telegramId?: string
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
    return { ok: false, message: 'Выберите менеджера по кадрам.' }
  }
  // Обязательные поля при ПЕРЕДАЧЕ лида менеджеру по кадрам. Обычное
  // сохранение (в т.ч. тихий черновик для вложений через ensureCardId)
  // остаётся мягким — иначе прикрепить файл к недозаполненной карточке
  // стало бы невозможно.
  if (input.curatorId) {
    if (!input.telegramUsername.trim()) {
      return { ok: false, message: 'Укажите Telegram (юзик) лида.' }
    }
    if (!input.vacancy.trim()) {
      return { ok: false, message: 'Укажите вакансию / должность.' }
    }
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
      telegramId: input.telegramId ?? '',
      city: input.city,
      address: input.address,
      vacancy: input.vacancy,
      curatorId: input.curatorId ?? null,
      isAdmin: session.role === 'admin',
    })
    if (transferred && card.curatorId) {
      void notifyCuratorOfTransfer(card.curatorId, card.fullName, card.city)
    }

    const warn = duplicateWarning ? ` ${duplicateWarning}` : ''
    if (transferred) {
      return {
        ok: true,
        message: `Лид передан менеджеру по кадрам${card.curatorName ? ` ${card.curatorName}` : ''}.${warn}`,
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

  // Админ / её куратор / её менеджер / руководитель её куратора.
  const allowed = await canAccessLeadCardAsync(session, card)
  if (!allowed) throw new Error('Forbidden')

  const [comments, transfers, statusHistory, attachments] = await Promise.all([
    listLeadComments(leadCardId),
    listLeadTransfers(leadCardId),
    listLeadStatusHistory(leadCardId).catch(() => []),
    listLeadAttachments(leadCardId).catch(() => []),
  ])
  return {
    card,
    comments,
    transfers,
    statusHistory,
    attachments: withCanDelete(session, attachments),
  }
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
    // Пуш менеджеру карточки: он сразу видит вердикт менеджера по кадрам, не заходя в
    // «Мои лиды». Доставка не должна ломать основное действие — fire-and-forget.
    void (async () => {
      const card = await getLeadCardById(input.leadCardId)
      if (!card?.managerId) return
      await sendPushToManager(card.managerId, {
        title: `Лид: ${leadStatusLabel(input.status)}`,
        body: `${card.fullName || 'Лид'} — менеджер по кадрам обновил статус. ${input.comment.trim().slice(0, 120)}`,
        url: '/app/leads',
        tag: `lead-status-${input.leadCardId}`,
      })
    })().catch(() => {})
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
  const session = await getSession()
  if (!session) return { ok: false, message: 'Не авторизовано.' }
  if (input.body.trim().length < 1) {
    return { ok: false, message: 'Введите комментарий.' }
  }
  const card = await getLeadCardById(input.leadCardId)
  if (!card || !(await canAccessLeadCardAsync(session, card))) {
    return { ok: false, message: 'Лид не найден.' }
  }
  try {
    // Для менеджера по кадрам свободный комментарий — часть ограниченного рабочего места:
    // сначала подтверди статусы. Менеджер и админ под гейт не попадают.
    if (session.role === 'curator') {
      await assertCuratorNotLocked(session.sub)
    }
    // Руководитель пишет комментарии только с правом «редактирование».
    if (session.role === 'head') {
      await assertHeadCanEdit(session.sub)
    }
    // Админ живёт вне таблицы managers (sub = 'admin') — FK хранит NULL,
    // имя уходит снапшотом, как в корзине и журнале статусов.
    const isRootAdmin = session.role === 'admin' && session.sub === 'admin'
    await addLeadComment({
      leadCardId: input.leadCardId,
      authorId: isRootAdmin ? null : session.sub,
      authorName: isRootAdmin ? (session.name ?? 'Администратор') : null,
      body: input.body,
    })
    // Менеджер по кадрам написал комментарий → пуш менеджеру карточки (не самому себе).
    if (session.role === 'curator' && card.managerId) {
      void sendPushToManager(card.managerId, {
        title: 'Комментарий менеджера по кадрам',
        body: `${card.fullName || 'Лид'}: ${input.body.trim().slice(0, 140)}`,
        url: '/app/leads',
        tag: `lead-comment-${input.leadCardId}`,
      }).catch(() => {})
    }
    return { ok: true, message: 'Комментарий добавлен.' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка'
    return { ok: false, message: msg }
  }
}

/**
 * Правка своего комментария — только в день его создания (по МСК).
 * Прошлый текст сохраняется в ревизиях и остаётся видимым всем: правка
 * не скрывает историю, а дополняет её.
 */
export async function editLeadCommentAction(input: {
  commentId: string
  leadCardId: string
  body: string
}): Promise<LeadCardActionResult> {
  const session = await getSession()
  if (!session) return { ok: false, message: 'Не авторизовано.' }
  if (input.body.trim().length < 1) {
    return { ok: false, message: 'Введите комментарий.' }
  }
  // Доступ к карточке — как для чтения (админ / её куратор / её менеджер /
  // руководитель группы); авторство проверяет editLeadComment.
  const card = await getLeadCardById(input.leadCardId)
  if (!card || !(await canAccessLeadCardAsync(session, card))) {
    return { ok: false, message: 'Лид не найден.' }
  }
  // Root-админ живёт вне managers — его комментарии имеют author_id = NULL
  // и не могут быть отредактированы (авторство не доказать).
  if (session.role === 'admin' && session.sub === 'admin') {
    return { ok: false, message: 'Комментарии администратора не редактируются.' }
  }
  try {
    const comments = await listLeadComments(input.leadCardId)
    const comment = comments.find((c) => c.id === input.commentId)
    if (!comment) return { ok: false, message: 'Комментарий не найден.' }
    if (comment.authorId !== session.sub) {
      return { ok: false, message: 'Можно править только свои комментарии.' }
    }
    // Дедлайн: комментарий правится только в МСК-день создания.
    if (mskDayKey(comment.createdAt) !== mskDayKey(new Date())) {
      return {
        ok: false,
        message: 'Комментарий можно редактировать только в день его создания.',
      }
    }
    await editLeadComment({
      commentId: input.commentId,
      editorId: session.sub,
      editorName: session.name ?? null,
      newBody: input.body,
    })
    return { ok: true, message: 'Комментарий обновлён.' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка'
    return { ok: false, message: msg }
  }
}
