'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  addMessage,
  editMessageBody,
  enqueueJob,
  getConversation,
  getMessageDispatch,
  listMessages,
  listMessagesBefore,
  markMessageDeleted,
  markMessageFailed,
  setConversationAiAutopilot,
  setMessageReaction,
} from '@/lib/data'
import type { Message } from '@/lib/types'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import {
  acknowledgeAiHandoff,
  getAiAssistSettings,
} from '@/lib/data/ai-assist'

export interface SimpleResult {
  ok: boolean
  message: string
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

  try {
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
    })
  } catch (err) {
    // If the job never made it into the queue the worker will never send this
    // reply. Don't tell the operator it was "sent" — flag the row failed and
    // report the failure, mirroring sendMessageAction's Telegram branch.
    console.error('[panel] failed to enqueue reply job:', err)
    await markMessageFailed(
      msg.id,
      'Не удалось поставить ответ в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath('/app/inbox')
    return {
      ok: false,
      message: 'Не удалось отправить — ответ не поставлен в очередь.',
    }
  }

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
 * Edit the text of the manager's OWN outgoing message (Telegram only),
 * Telegram-style. The previous version is snapshotted into the append-only
 * `message_edits` history, the live row is overwritten, and an edit_message
 * job tells the worker to apply the edit in Telegram so the contact sees the
 * native "edited" mark. Manager-scoped: only messages in own conversations,
 * and only outbound ones.
 */
export async function editMessageAction(
  messageId: string,
  body: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  const text = body.trim()
  if (!text) return { ok: false, message: 'Текст не может быть пустым.' }

  const dispatch = await getMessageDispatch(messageId, session.sub)
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

  const changed = await editMessageBody(messageId, session.sub, text)
  if (!changed) return { ok: true, message: 'Без изменений.' }

  await enqueueJob({
    channelId: dispatch.channelId,
    managerId: session.sub,
    action: 'edit_message',
    payload: {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
      body: text,
    },
  }).catch((err) => {
    console.error('[panel] failed to enqueue edit job:', err)
  })

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Сообщение изменено.' }
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
  // Without the placeholder there is nowhere to write the delivery status —
  // abort instead of enqueueing a job whose result would be silently lost.
  if (!placeholder) {
    return { ok: false, message: 'Не удалось создать сообщение в диалоге получателя.' }
  }

  try {
    await enqueueJob({
      channelId: dest.channelId,
      managerId: session.sub,
      action: 'forward_message',
      payload: {
        fromTarget: source.contactHandle,
        toTarget: dest.contactHandle,
        providerMessageId: source.providerMessageId,
        messageId: placeholder.id,
      },
    })
  } catch (err) {
    console.error('[panel] failed to enqueue forward job:', err)
    await markMessageFailed(
      placeholder.id,
      'Не удалось поставить пересылку в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath('/app/inbox')
    return { ok: false, message: 'Не удалось переслать — задача не поставлена в очередь.' }
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: `Переслано: ${dest.contactName || dest.contactHandle}` }
}

/**
 * Turn the AI manager-assistant on/off for a single conversation (the per-thread
 * toggle in the inbox). When switching ON, the AI will re-read the whole thread
 * and continue leading from the next inbound message. Manager-scoped: you can
 * only toggle conversations you own. Refuses to switch on when the global
 * assistant is disabled or the AI Gateway key is missing.
 */
export async function toggleConversationAiAction(
  conversationId: string,
  enabled: boolean,
): Promise<SimpleResult> {
  const session = await requireManager()

  if (enabled) {
    if (!isBrainConfigured()) {
      return {
        ok: false,
        message: 'ИИ не настроен: не задан ключ AI Gateway.',
      }
    }
    const settings = await getAiAssistSettings()
    if (!settings.enabled) {
      return {
        ok: false,
        message: 'ИИ отключён администратором в разделе «ИИ-ассистент».',
      }
    }
  }

  const state = await setConversationAiAutopilot(
    conversationId,
    session.sub,
    enabled,
  )
  if (state === null) return { ok: false, message: 'Диалог не найден.' }

  revalidatePath('/app/inbox')
  return {
    ok: true,
    message: state
      ? 'ИИ ведёт этот диалог. Он проанализирует переписку и продолжит общение.'
      : 'ИИ отключён для этого диалога.',
  }
}

/**
 * Manager acknowledges an AI→human handoff (opened the «Ликвид» thread): clears
 * the pending-handoff flag so the inbox banner/highlight goes away. Manager-
 * scoped and best-effort — a stale ack must never surface an error to the user.
 */
export async function acknowledgeAiHandoffAction(
  conversationId: string,
): Promise<void> {
  const session = await requireManager()
  await acknowledgeAiHandoff(conversationId, session.sub).catch(() => {})
  revalidatePath('/app/inbox')
}

/**
 * Fetch an older page of a thread's history (messages created before `before`,
 * an ISO timestamp). Used by the inbox "load older messages" control for threads
 * that were truncated to the most-recent slice on first load. Manager-scoped, so
 * a foreign conversation id just returns an empty page. `hasMore` reflects
 * whether a full page came back (i.e. there is probably still older history).
 */
/**
 * First-open hydration for threads OUTSIDE the SSR preload slice: the inbox
 * page only ships transcripts for the top of the list, so clicking a colder
 * thread fetches its recent history here (ownership enforced by the query).
 */
export async function loadThreadMessagesAction(
  conversationId: string,
): Promise<{ ok: boolean; messages: Message[] }> {
  const session = await requireManager()
  if (!conversationId) return { ok: false, messages: [] }
  const messages = await listMessages(conversationId, session.sub)
  return { ok: true, messages }
}

export async function loadOlderMessagesAction(
  conversationId: string,
  before: string,
): Promise<{ ok: boolean; messages: Message[]; hasMore: boolean }> {
  const session = await requireManager()
  if (!conversationId || !before) {
    return { ok: false, messages: [], hasMore: false }
  }
  const PAGE = 100
  const messages = await listMessagesBefore(
    conversationId,
    session.sub,
    before,
    PAGE,
  )
  return { ok: true, messages, hasMore: messages.length >= PAGE }
}
