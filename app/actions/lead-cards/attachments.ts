'use server'

/**
 * Вложения карточки лида: список, закрепление кружков из диалога, удаление.
 * Часть распила app/actions/lead-cards.ts.
 *
 * Кружки (video_note) живут в ДИАЛОГЕ менеджера с клиентом — выбирает и
 * закрепляет их менеджер (или админ). Менеджер по кадрам диалога не ведёт и
 * доступа к его содержимому не имеет: он видит только уже закреплённые
 * вложения в карточке.
 */
import { getSession } from '@/lib/auth'
import {
  getLeadCardByConversation,
  getLeadCardById,
} from '@/lib/data/lead-cards'
import {
  addLeadVideoNoteAttachment,
  deleteLeadAttachment,
  getLeadAttachmentById,
  listConversationVideoNotes,
  listLeadAttachments,
  type ConversationVideoNote,
} from '@/lib/data/lead-attachments'
import {
  canAccessLeadCard,
  withCanDelete,
  type LeadAttachmentView,
} from './shared'

/** Список вложений карточки (для менеджера/менеджера по кадрам/админа с доступом). */
export async function listLeadAttachmentsAction(leadCardId: string) {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  const card = await getLeadCardById(leadCardId)
  if (!card || !canAccessLeadCard(session, card)) throw new Error('Forbidden')
  return withCanDelete(session, await listLeadAttachments(leadCardId))
}

// Загрузка фото/видео идёт через POST /api/lead-media/upload (route handler):
// server action с крупным телом (видео) режется прокси-слоями до обработчика
// и падает с генерик-ошибкой. Роут возвращает честный JSON и статус.

/** true, когда сессия может выбирать кружки из диалога карточки (менеджер карточки или админ). */
function canBrowseDialogVideoNotes(
  session: { role: string; sub: string },
  card: { managerId: string | null },
): boolean {
  return (
    session.role === 'admin' ||
    (session.role === 'manager' && card.managerId === session.sub)
  )
}

/**
 * Кружки (video_note) диалога по порядку — для выбора при закреплении.
 * Только менеджер, ведущий диалог, и админ: менеджер по кадрам содержимое
 * диалога не просматривает.
 */
export async function listConversationVideoNotesAction(
  conversationId: string,
): Promise<ConversationVideoNote[]> {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  if (session.role === 'curator') throw new Error('Forbidden')
  const card = await getLeadCardByConversation(conversationId)
  if (card && !canBrowseDialogVideoNotes(session, card)) {
    throw new Error('Forbidden')
  }
  return listConversationVideoNotes(conversationId)
}

/** Закрепить кружок из диалога за карточкой — менеджер карточки или админ. */
export async function attachLeadVideoNoteAction(input: {
  leadCardId: string
  conversationId: string
  messageId: string
}): Promise<{ ok: boolean; message: string; attachments?: LeadAttachmentView[] }> {
  const session = await getSession()
  if (!session) return { ok: false, message: 'Не авторизовано.' }
  if (session.role === 'curator') {
    return {
      ok: false,
      message: 'Кружок из диалога закрепляет менеджер, который ведёт диалог.',
    }
  }
  const card = await getLeadCardById(input.leadCardId)
  if (!card || !canAccessLeadCard(session, card)) {
    return { ok: false, message: 'Лид не найден.' }
  }
  if (!canBrowseDialogVideoNotes(session, card)) {
    return { ok: false, message: 'Нет доступа к диалогу этой карточки.' }
  }
  if (card.conversationId !== input.conversationId) {
    return { ok: false, message: 'Кружок из другого диалога.' }
  }
  try {
    const res = await addLeadVideoNoteAttachment({
      leadCardId: input.leadCardId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      authorId: session.sub,
    })
    if (!res) return { ok: false, message: 'Это не кружок этого диалога.' }
    const attachments = withCanDelete(
      session,
      await listLeadAttachments(input.leadCardId),
    )
    return { ok: true, message: 'Кружок закреплён.', attachments }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка'
    return { ok: false, message: msg }
  }
}

/** Удалить вложение — только автор или админ. */
export async function deleteLeadAttachmentAction(input: {
  attachmentId: string
}): Promise<{ ok: boolean; message: string; attachments?: LeadAttachmentView[] }> {
  const session = await getSession()
  if (!session) return { ok: false, message: 'Не авторизовано.' }
  const attachment = await getLeadAttachmentById(input.attachmentId)
  if (!attachment) return { ok: false, message: 'Вложение не найдено.' }
  if (session.role !== 'admin' && attachment.authorId !== session.sub) {
    return { ok: false, message: 'Удалять может только автор.' }
  }
  try {
    await deleteLeadAttachment(input.attachmentId)
    const attachments = withCanDelete(
      session,
      await listLeadAttachments(attachment.leadCardId),
    )
    return { ok: true, message: 'Вложение удалено.', attachments }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка'
    return { ok: false, message: msg }
  }
}
