'use server'

import { revalidatePath } from 'next/cache'
import { requireCurator } from '@/lib/auth'
import { addMessage, enqueueJob, markMessageFailed } from '@/lib/data'
import {
  getConversationForCurator,
  listMessagesBeforeForCurator,
  listMessagesForCurator,
  markCuratorConversationRead,
} from '@/lib/data/curator-conversations'
import { deliverMaxMessage } from '@/lib/max-dispatch'
import { deliverVkMessage, markVkConversationRead } from '@/lib/vk-dispatch'
import {
  deliverWhatsappMessage,
  markWhatsappConversationRead,
} from '@/lib/whatsapp-dispatch'
import type { Message } from '@/lib/types'

export interface SimpleResult {
  ok: boolean
  message: string
}

/** Путь ревалидации раздела «Чаты» куратора. */
const CURATOR_CHATS_PATH = '/curator/chats'

/**
 * Куратор отправляет текстовое сообщение в ПЕРЕДАННЫЙ ему диалог. Полное
 * зеркало менеджерского sendMessageAction, но со скоупом по curator_id:
 * владение проверяет getConversationForCurator, а вставку делает addMessage с
 * curatorId (INSERT ... WHERE curator_id = $) — чужой диалог просто вернёт null.
 * Маршрутизация доставки по каналам идентична менеджерской.
 */
export async function sendCuratorMessageAction(
  conversationId: string,
  body: string,
  replyToMessageId?: string,
): Promise<SimpleResult> {
  const session = await requireCurator()
  const text = body.trim()
  if (!text) return { ok: false, message: 'Сообщение пустое.' }

  const conv = await getConversationForCurator(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }

  const msg = await addMessage({
    conversationId,
    // Владение диалогом остаётся у менеджера; сообщение вставляем под
    // curator-скоупом, но строка принадлежит owner-менеджеру диалога.
    managerId: conv.managerId,
    curatorId: session.sub,
    body: text,
    author: session.name,
    // Ответ-цитата: воркер Telegram проставит reply_to при доставке.
    replyToMessageId: replyToMessageId || undefined,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  if (conv.channelType === 'whatsapp') {
    const handled = await deliverWhatsappMessage(conversationId, msg.id, text)
    if (!handled) {
      await markMessageFailed(
        msg.id,
        'WhatsApp не настроен: обратитесь к администратору.',
      ).catch(() => {})
      revalidatePath(CURATOR_CHATS_PATH)
      return { ok: false, message: 'WhatsApp не настроен — обратитесь к администратору.' }
    }
  } else if (conv.channelType === 'telegram') {
    try {
      await enqueueJob({
        channelId: conv.channelId,
        managerId: conv.managerId,
        action: 'send_message',
        payload: { target: conv.contactHandle, body: text, messageId: msg.id },
      })
    } catch (err) {
      console.error('[panel] curator send_message enqueue failed:', err)
      await markMessageFailed(
        msg.id,
        'Не удалось поставить сообщение в очередь. Попробуйте ещё раз.',
      ).catch(() => {})
      revalidatePath(CURATOR_CHATS_PATH)
      return {
        ok: false,
        message: 'Не удалось отправить — сообщение не поставлено в очередь.',
      }
    }
  } else if (conv.channelType === 'max') {
    await deliverMaxMessage(conversationId, msg.id, text)
  } else if (conv.channelType === 'vk') {
    await deliverVkMessage(conversationId, msg.id, text)
  }

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: 'Отправлено.' }
}

/** Отметить диалог куратора прочитанным + отправить read-receipt (как у менеджера). */
export async function markCuratorConversationReadAction(
  conversationId: string,
): Promise<SimpleResult> {
  const session = await requireCurator()
  const conv = await markCuratorConversationRead(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }

  if (conv.channelType === 'whatsapp') {
    await markWhatsappConversationRead(conversationId)
  } else if (conv.channelType === 'telegram') {
    // Read-receipt отправляем через воркер под owner-менеджером диалога.
    const owner = await getConversationForCurator(conversationId, session.sub)
    if (owner) {
      await enqueueJob({
        channelId: conv.channelId,
        managerId: owner.managerId,
        action: 'mark_read',
        payload: { target: conv.contactHandle },
      }).catch((err) => {
        console.error('[panel] curator mark_read enqueue failed:', err)
      })
    }
  } else if (conv.channelType === 'vk') {
    await markVkConversationRead(conversationId)
  }

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: 'Прочитано.' }
}

/** Первичная догрузка треда для холодного диалога (вне SSR-слайса). */
export async function loadCuratorThreadMessagesAction(
  conversationId: string,
): Promise<{ ok: boolean; messages: Message[] }> {
  const session = await requireCurator()
  if (!conversationId) return { ok: false, messages: [] }
  const messages = await listMessagesForCurator(conversationId, session.sub)
  return { ok: true, messages }
}

/** Догрузка более старой истории (пагинация вверх). */
export async function loadOlderCuratorMessagesAction(
  conversationId: string,
  before: string,
): Promise<{ ok: boolean; messages: Message[]; hasMore: boolean }> {
  const session = await requireCurator()
  if (!conversationId || !before) {
    return { ok: false, messages: [], hasMore: false }
  }
  const PAGE = 100
  const messages = await listMessagesBeforeForCurator(
    conversationId,
    session.sub,
    before,
    PAGE,
  )
  return { ok: true, messages, hasMore: messages.length >= PAGE }
}
