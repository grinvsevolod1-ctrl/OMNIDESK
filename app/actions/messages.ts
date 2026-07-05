'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  addMessage,
  enqueueJob,
  getConversation,
  getMessageDispatch,
  markMessageDeleted,
  setMessageReaction,
} from '@/lib/data'
import { publishRealtime } from '@/lib/realtime'
import { setVkTyping } from '@/lib/vk-dispatch'

export interface SimpleResult {
  ok: boolean
  message: string
}

/**
 * Tell the website visitor that their assigned agent is typing (live-chat only).
 *
 * Ephemeral and best-effort: publishes a `typing` realtime event scoped to the
 * conversation's channel + visitor handle, which the widget's SSE stream relays
 * as "<name> печатает". Nothing is stored. No-ops for Telegram/WhatsApp, where
 * outbound typing would require provider support in the worker.
 */
export async function setAgentTypingAction(
  conversationId: string,
  typing: boolean,
): Promise<void> {
  const session = await requireManager()
  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return

  // VK exposes a real "typing…" indicator via messages.setActivity — surface it
  // to the user through the account's proxy. Only meaningful when turning on.
  if (conv.channelType === 'vk') {
    if (typing) await setVkTyping(conversationId)
    return
  }

  // Live-chat typing is an ephemeral realtime event relayed to the widget.
  if (conv.channelType !== 'livechat') return
  await publishRealtime({
    type: 'typing',
    actor: 'agent',
    channelId: conv.channelId,
    conversationId,
    contactHandle: conv.contactHandle,
    authorName: session.name,
    typing,
  })
}

/**
 * Reply to a specific message (Telegram only). Records the outgoing reply with a
 * quote link, then enqueues a send_message job carrying the quoted message's
 * Telegram id so the reply threads correctly in Telegram.
 */
export async function replyMessageAction(
  conversationId: string,
  replyToMessageId: string,
  body: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  const text = body.trim()
  if (!text) return { ok: false, message: 'Сообщение пустое.' }

  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'telegram') {
    return { ok: false, message: 'Ответы доступны только для Telegram.' }
  }

  // Provider id of the message we're replying to.
  const target = await getMessageDispatch(replyToMessageId, session.sub)
  if (!target) return { ok: false, message: 'Сообщение не найдено.' }

  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: text,
    author: session.name,
    replyToMessageId,
  })
  if (!msg) return { ok: false, message: 'Не удалось отправить.' }

  await enqueueJob({
    channelId: conv.channelId,
    managerId: session.sub,
    action: 'send_message',
    payload: {
      target: conv.contactHandle,
      body: text,
      replyToProviderId: target.providerMessageId,
      messageId: msg.id,
    },
  }).catch((err) => {
    console.error('[panel] failed to enqueue reply job:', err)
  })

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Ответ отправлен.' }
}

/**
 * Toggle an emoji reaction on a message (Telegram only). Passing an empty emoji
 * clears the reaction.
 */
export async function reactMessageAction(
  messageId: string,
  emoji: string,
): Promise<SimpleResult> {
  const session = await requireManager()

  const dispatch = await getMessageDispatch(messageId, session.sub)
  if (!dispatch) return { ok: false, message: 'Сообщение не найдено.' }
  if (dispatch.channelType !== 'telegram') {
    return { ok: false, message: 'Реакции доступны только для Telegram.' }
  }
  if (!dispatch.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  await setMessageReaction(messageId, session.sub, emoji || null)

  await enqueueJob({
    channelId: dispatch.channelId,
    managerId: session.sub,
    action: 'react_message',
    payload: {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
      emoji,
    },
  }).catch((err) => {
    console.error('[panel] failed to enqueue react job:', err)
  })

  revalidatePath('/app/inbox')
  return { ok: true, message: emoji ? 'Реакция добавлена.' : 'Реакция убрана.' }
}

/**
 * Delete a message for everyone (Telegram only). Soft-deletes locally and tells
 * the worker to revoke it in Telegram.
 */
export async function deleteMessageAction(
  messageId: string,
): Promise<SimpleResult> {
  const session = await requireManager()

  const dispatch = await getMessageDispatch(messageId, session.sub)
  if (!dispatch) return { ok: false, message: 'Сообщение не найдено.' }
  if (dispatch.channelType !== 'telegram') {
    return { ok: false, message: 'Удаление доступно только для Telegram.' }
  }
  if (!dispatch.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  await markMessageDeleted(messageId, session.sub)

  await enqueueJob({
    channelId: dispatch.channelId,
    managerId: session.sub,
    action: 'delete_message',
    payload: {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
    },
  }).catch((err) => {
    console.error('[panel] failed to enqueue delete job:', err)
  })

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Сообщение удалено.' }
}

/**
 * Forward a message to another Telegram conversation (both owned by this
 * manager). Records a placeholder outgoing message in the destination thread and
 * enqueues a forward_message job.
 */
export async function forwardMessageAction(
  messageId: string,
  toConversationId: string,
): Promise<SimpleResult> {
  const session = await requireManager()

  const source = await getMessageDispatch(messageId, session.sub)
  if (!source) return { ok: false, message: 'Сообщение не найдено.' }
  if (source.channelType !== 'telegram') {
    return { ok: false, message: 'Пересылка доступна только для Telegram.' }
  }
  if (!source.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  const dest = await getConversation(toConversationId, session.sub)
  if (!dest) return { ok: false, message: 'Получатель не найден.' }
  if (dest.channelType !== 'telegram') {
    return { ok: false, message: 'Переслать можно только в Telegram-диалог.' }
  }

  const placeholder = await addMessage({
    conversationId: toConversationId,
    managerId: session.sub,
    body: '[Пересланное сообщение]',
    author: session.name,
  })

  await enqueueJob({
    channelId: dest.channelId,
    managerId: session.sub,
    action: 'forward_message',
    payload: {
      fromTarget: source.contactHandle,
      toTarget: dest.contactHandle,
      providerMessageId: source.providerMessageId,
      messageId: placeholder?.id,
    },
  }).catch((err) => {
    console.error('[panel] failed to enqueue forward job:', err)
  })

  revalidatePath('/app/inbox')
  return { ok: true, message: `Переслано: ${dest.contactName}` }
}
