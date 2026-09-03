'use server'

import { revalidatePath } from 'next/cache'
import { requireCurator } from '@/lib/auth'
import {
  addMessage,
  editMessageBodyForCurator,
  enqueueJob,
  getMessageDispatchForCurator,
  markMessageDeletedForCurator,
  markMessageFailed,
  setMessageReactionForCurator,
} from '@/lib/data'
import {
  getConversationForCurator,
  listMessagesBeforeForCurator,
  listMessagesForCurator,
  markCuratorConversationRead,
} from '@/lib/data/curator-conversations'
import type { StickerItem } from '@/lib/types'
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

/* -------------------------------------------------------------------------- *
 *  Telegram message actions (curator).                                        *
 *                                                                             *
 *  Full parity with the manager's message context-menu / composer: react,    *
 *  delete-for-everyone, edit own outgoing, forward, stickers, voice notes and *
 *  scheduled sends. Each mirrors the manager action verbatim but resolves     *
 *  ownership through the curator scope (`curator_id`) and enqueues the worker *
 *  job under the OWNING manager (the curator has no Telegram session/channel  *
 *  of their own — the account owner's session delivers everything).          *
 * -------------------------------------------------------------------------- */

/** Toggle an emoji reaction on a message (Telegram only, curator-scoped). */
export async function reactCuratorMessageAction(
  messageId: string,
  emoji: string,
): Promise<SimpleResult> {
  const session = await requireCurator()

  const dispatch = await getMessageDispatchForCurator(messageId, session.sub)
  if (!dispatch) return { ok: false, message: 'Сообщение не найдено.' }
  if (dispatch.channelType !== 'telegram') {
    return { ok: false, message: 'Реакции доступны только для Telegram.' }
  }
  if (!dispatch.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  await setMessageReactionForCurator(messageId, session.sub, emoji || null)

  await enqueueJob({
    channelId: dispatch.channelId,
    managerId: dispatch.managerId,
    action: 'react_message',
    payload: {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
      emoji,
    },
  }).catch((err) => {
    console.error('[panel] curator react enqueue failed:', err)
  })

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: emoji ? 'Реакция добавлена.' : 'Реакция убрана.' }
}

/** Delete a message for everyone (Telegram only, curator-scoped). */
export async function deleteCuratorMessageAction(
  messageId: string,
): Promise<SimpleResult> {
  const session = await requireCurator()

  const dispatch = await getMessageDispatchForCurator(messageId, session.sub)
  if (!dispatch) return { ok: false, message: 'Сообщение не найдено.' }
  if (dispatch.channelType !== 'telegram') {
    return { ok: false, message: 'Удаление доступно только для Telegram.' }
  }
  if (!dispatch.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  await markMessageDeletedForCurator(messageId, session.sub)

  await enqueueJob({
    channelId: dispatch.channelId,
    managerId: dispatch.managerId,
    action: 'delete_message',
    payload: {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
    },
  }).catch((err) => {
    console.error('[panel] curator delete enqueue failed:', err)
  })

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: 'Сообщение удалено.' }
}

/** Edit the text of the curator's OWN outgoing message (Telegram only). */
export async function editCuratorMessageAction(
  messageId: string,
  body: string,
): Promise<SimpleResult> {
  const session = await requireCurator()
  const text = body.trim()
  if (!text) return { ok: false, message: 'Текст не может быть пустым.' }

  const dispatch = await getMessageDispatchForCurator(messageId, session.sub)
  if (!dispatch) return { ok: false, message: 'Сообщение не найдено.' }
  if (dispatch.direction !== 'out') {
    return { ok: false, message: 'Можно редактировать только свои сообщения.' }
  }
  if (dispatch.channelType !== 'telegram') {
    return { ok: false, message: 'Редактирование доступно только для Telegram.' }
  }
  if (!dispatch.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  const changed = await editMessageBodyForCurator(messageId, session.sub, text)
  if (!changed) return { ok: true, message: 'Без изменений.' }

  await enqueueJob({
    channelId: dispatch.channelId,
    managerId: dispatch.managerId,
    action: 'edit_message',
    payload: {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
      body: text,
    },
  }).catch((err) => {
    console.error('[panel] curator edit enqueue failed:', err)
  })

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: 'Сообщение изменено.' }
}

/**
 * Forward a message to another Telegram conversation. Both the source message
 * and the destination conversation must be transferred to THIS curator (both
 * resolved under the curator scope), and both must be Telegram. The worker job
 * runs under the destination's owning manager.
 */
export async function forwardCuratorMessageAction(
  messageId: string,
  toConversationId: string,
): Promise<SimpleResult> {
  const session = await requireCurator()

  const source = await getMessageDispatchForCurator(messageId, session.sub)
  if (!source) return { ok: false, message: 'Сообщение не найдено.' }
  if (source.channelType !== 'telegram') {
    return { ok: false, message: 'Пересылка доступна только для Telegram.' }
  }
  if (!source.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  const dest = await getConversationForCurator(toConversationId, session.sub)
  if (!dest) return { ok: false, message: 'Получатель не найден.' }
  if (dest.channelType !== 'telegram') {
    return { ok: false, message: 'Переслать можно только в Telegram-диалог.' }
  }

  const placeholder = await addMessage({
    conversationId: toConversationId,
    managerId: dest.managerId,
    curatorId: session.sub,
    body: '[Пересланное сообщение]',
    author: session.name,
  })
  if (!placeholder) {
    return {
      ok: false,
      message: 'Не удалось создать сообщение в диалоге получателя.',
    }
  }

  try {
    await enqueueJob({
      channelId: dest.channelId,
      managerId: dest.managerId,
      action: 'forward_message',
      payload: {
        fromTarget: source.contactHandle,
        toTarget: dest.contactHandle,
        providerMessageId: source.providerMessageId,
        messageId: placeholder.id,
      },
    })
  } catch (err) {
    console.error('[panel] curator forward enqueue failed:', err)
    await markMessageFailed(
      placeholder.id,
      'Не удалось поставить пересылку в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath(CURATOR_CHATS_PATH)
    return {
      ok: false,
      message: 'Не удалось переслать — задача не поставлена в очередь.',
    }
  }

  revalidatePath(CURATOR_CHATS_PATH)
  return {
    ok: true,
    message: `Переслано: ${dest.contactName || dest.contactHandle}`,
  }
}

/** Send a sticker (Telegram only, curator-scoped). */
export async function sendCuratorStickerAction(
  conversationId: string,
  sticker: StickerItem,
): Promise<SimpleResult> {
  const session = await requireCurator()
  if (
    !sticker ||
    !sticker.id ||
    !sticker.accessHash ||
    !sticker.fileReference
  ) {
    return { ok: false, message: 'Некорректный стикер.' }
  }

  const conv = await getConversationForCurator(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'telegram') {
    return { ok: false, message: 'Стикеры доступны только для Telegram.' }
  }

  const msg = await addMessage({
    conversationId,
    managerId: conv.managerId,
    curatorId: session.sub,
    body: sticker.emoji || '[Стикер]',
    author: session.name,
    mediaType: 'sticker',
    mediaMime: sticker.mime || 'image/webp',
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  await enqueueJob({
    channelId: conv.channelId,
    managerId: conv.managerId,
    action: 'send_sticker',
    payload: {
      target: conv.contactHandle,
      documentId: sticker.id,
      accessHash: sticker.accessHash,
      fileReference: sticker.fileReference,
      emoji: sticker.emoji,
    },
  }).catch((err) => {
    console.error('[panel] curator send_sticker enqueue failed:', err)
  })

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: 'Стикер отправлен.' }
}

/** Hard cap on a recorded voice note (bytes, pre-base64) — mirrors manager. */
const CURATOR_VOICE_MAX_BYTES = 1_048_576

/** Send a voice note recorded in the composer (Telegram only, curator-scoped). */
export async function sendCuratorVoiceAction(
  conversationId: string,
  audio: { base64: string; mime: string; durationSec: number },
): Promise<SimpleResult> {
  const session = await requireCurator()
  if (!audio?.base64) return { ok: false, message: 'Пустая запись.' }
  const approxBytes = Math.floor(audio.base64.length * 0.75)
  if (approxBytes > CURATOR_VOICE_MAX_BYTES) {
    return { ok: false, message: 'Запись слишком длинная (лимит ~1 МБ).' }
  }
  const durationSec = Math.min(600, Math.max(1, Math.round(audio.durationSec)))

  const conv = await getConversationForCurator(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'telegram') {
    return { ok: false, message: 'Голосовые доступны только для Telegram.' }
  }

  const msg = await addMessage({
    conversationId,
    managerId: conv.managerId,
    curatorId: session.sub,
    body: '[Голосовое сообщение]',
    author: session.name,
    mediaType: 'voice',
    mediaMime: audio.mime || 'audio/ogg',
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  try {
    await enqueueJob({
      channelId: conv.channelId,
      managerId: conv.managerId,
      action: 'send_voice',
      payload: {
        target: conv.contactHandle,
        audio: audio.base64,
        durationSec,
        messageId: msg.id,
      },
    })
  } catch (err) {
    console.error('[panel] curator send_voice enqueue failed:', err)
    await markMessageFailed(
      msg.id,
      'Не удалось поставить голосовое в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath(CURATOR_CHATS_PATH)
    return { ok: false, message: 'Не удалось отправить голосовое.' }
  }

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: 'Голосовое отправлено.' }
}

/** Schedule a message for later delivery (Telegram only, curator-scoped). */
export async function sendCuratorScheduledMessageAction(
  conversationId: string,
  body: string,
  scheduleAtIso: string,
): Promise<SimpleResult> {
  const session = await requireCurator()
  const text = body.trim()
  if (!text) return { ok: false, message: 'Сообщение пустое.' }

  const scheduleAt = new Date(scheduleAtIso)
  const nowMs = Date.now()
  if (Number.isNaN(scheduleAt.getTime())) {
    return { ok: false, message: 'Некорректная дата.' }
  }
  if (scheduleAt.getTime() < nowMs + 2 * 60_000) {
    return { ok: false, message: 'Время должно быть минимум через 2 минуты.' }
  }
  if (scheduleAt.getTime() > nowMs + 365 * 24 * 3_600_000) {
    return { ok: false, message: 'Максимум — год вперёд.' }
  }

  const conv = await getConversationForCurator(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'telegram') {
    return {
      ok: false,
      message: 'Отложенная отправка доступна только для Telegram.',
    }
  }

  const when = scheduleAt.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  })
  const msg = await addMessage({
    conversationId,
    managerId: conv.managerId,
    curatorId: session.sub,
    body: text,
    preview: `[Запланировано на ${when}] ${text}`,
    author: session.name,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  try {
    await enqueueJob({
      channelId: conv.channelId,
      managerId: conv.managerId,
      action: 'send_message',
      payload: {
        target: conv.contactHandle,
        body: text,
        messageId: msg.id,
        scheduleAt: Math.floor(scheduleAt.getTime() / 1000),
      },
    })
  } catch (err) {
    console.error('[panel] curator scheduled send enqueue failed:', err)
    await markMessageFailed(
      msg.id,
      'Не удалось поставить сообщение в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath(CURATOR_CHATS_PATH)
    return { ok: false, message: 'Не удалось запланировать отправку.' }
  }

  revalidatePath(CURATOR_CHATS_PATH)
  return { ok: true, message: `Запланировано на ${when} (МСК).` }
}
