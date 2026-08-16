'use server'

import { revalidatePath } from 'next/cache'
import { invalidateAnalytics } from '@/lib/analytics-cache'
import { requireManager } from '@/lib/auth'
import {
  listTransferTargets,
  recordTelemostMeeting,
  transferConversation,
  type TransferTarget,
} from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'
import { createTelemostMeeting, isTelemostConfigured } from '@/lib/telemost'
import { sendMessageAction } from '@/app/actions/account'

export interface SimpleResult {
  ok: boolean
  message: string
}

/**
 * Manager: list colleagues a conversation can be handed off to (active managers
 * except the caller). Used to populate the transfer picker in the inbox.
 */
export async function listTransferTargetsAction(): Promise<TransferTarget[]> {
  const session = await requireManager()
  return listTransferTargets(session.sub)
}

/**
 * Manager: hand one of OWN conversations off to another manager, with an
 * optional handover note. Scoped to the owning manager, so a thread you don't
 * own can't be transferred.
 */
export async function transferConversationAction(
  conversationId: string,
  toManagerId: string,
  note?: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  if (!conversationId || !toManagerId) {
    return { ok: false, message: 'Выберите менеджера для передачи.' }
  }
  if (toManagerId === session.sub) {
    return { ok: false, message: 'Нельзя передать диалог самому себе.' }
  }

  const ok = await transferConversation({
    conversationId,
    fromManagerId: session.sub,
    toManagerId,
    note,
  })
  if (!ok) {
    return {
      ok: false,
      message: 'Не удалось передать диалог. Обновите страницу и попробуйте снова.',
    }
  }

  // Reassigning a conversation moves it between managers in the performance and
  // group rollups, so drop the analytics cache to reflect it right away.
  invalidateAnalytics()
  await writeAudit({
    actorRole: 'manager',
    actorId: session.sub,
    actorLabel: session.name,
    action: 'conversation.transfer',
    entityType: 'conversation',
    entityId: conversationId,
    details: { toManagerId, hasNote: Boolean(note?.trim()) },
  })
  revalidatePath('/app/inbox')
  revalidatePath('/app')
  return { ok: true, message: 'Диалог передан менеджеру.' }
}

/* ----------------------------- Video meeting ----------------------------- */

export interface MeetingResult {
  ok: boolean
  message: string
  joinUrl?: string
}

/**
 * Manager: create a Yandex Telemost video meeting and send the join link to the
 * client through the current conversation's channel. Reuses sendMessageAction so
 * the link is delivered exactly like any other outbound message (Telegram queue,
 * WhatsApp Cloud API, VK/MAX bot, or live-chat SSE) and appears in the thread.
 */
export async function createMeetingAction(
  conversationId: string,
  note?: string,
): Promise<MeetingResult> {
  const session = await requireManager()
  if (!conversationId) {
    return { ok: false, message: 'Диалог не выбран.' }
  }

  const meeting = await createTelemostMeeting()
  if (!meeting.ok) {
    return { ok: false, message: meeting.message }
  }

  // Compose a friendly Russian invite. An optional note (e.g. proposed time)
  // is prepended so the client gets context alongside the link.
  const prefix = note?.trim() ? `${note.trim()}\n\n` : ''
  const body = `${prefix}Приглашаю вас на видеовстречу в Яндекс Телемост:\n${meeting.meeting.joinUrl}`

  const sent = await sendMessageAction(conversationId, body)
  await recordTelemostMeeting({
    managerId: session.sub,
    conversationId,
    conferenceId: meeting.meeting.id,
    joinUrl: meeting.meeting.joinUrl,
    delivered: sent.ok,
  })
  if (!sent.ok) {
    // The meeting exists but we couldn't deliver the link — surface the link so
    // the manager can copy/paste it manually rather than losing it.
    return {
      ok: false,
      message: `Встреча создана, но ссылку не удалось отправить: ${sent.message}`,
      joinUrl: meeting.meeting.joinUrl,
    }
  }

  revalidatePath('/app/inbox')
  revalidatePath('/app/meetings')
  return {
    ok: true,
    message: 'Ссылка на видеовстречу отправлена клиенту.',
    joinUrl: meeting.meeting.joinUrl,
  }
}

/**
 * Manager: create a standalone Telemost meeting from the Видеовстречи tab (not
 * tied to a conversation). Returns the join link for the manager to share
 * manually; nothing is sent to any client.
 */
export async function createStandaloneMeetingAction(): Promise<MeetingResult> {
  const session = await requireManager()

  const meeting = await createTelemostMeeting()
  if (!meeting.ok) {
    return { ok: false, message: meeting.message }
  }

  await recordTelemostMeeting({
    managerId: session.sub,
    conversationId: null,
    conferenceId: meeting.meeting.id,
    joinUrl: meeting.meeting.joinUrl,
    delivered: false,
  })

  revalidatePath('/app/meetings')
  return {
    ok: true,
    message: 'Видеовстреча создана.',
    joinUrl: meeting.meeting.joinUrl,
  }
}

/** Whether the Telemost button should be shown/enabled in the composer. */
export async function isTelemostAvailableAction(): Promise<boolean> {
  await requireManager()
  return isTelemostConfigured()
}
