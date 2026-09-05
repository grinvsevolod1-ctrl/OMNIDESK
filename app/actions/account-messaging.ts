'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  addMessage,
  enqueueJob,
  getChannelById,
  getConversation,
  getOutreachChannel,
  markConversationRead,
  markMessageFailed,
  trashReworkLead,
} from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'
import { isTelegramDeliveryImpaired } from '@/lib/channel-health'
import type { Conversation } from '@/lib/types'
import { deliverMaxMessage } from '@/lib/max-dispatch'
import { deliverVkMessage, markVkConversationRead } from '@/lib/vk-dispatch'
import {
  deliverWhatsappMessage,
  markWhatsappConversationRead,
} from '@/lib/whatsapp-dispatch'
import type { StickerItem } from '@/lib/types'
import type { SimpleResult } from './account-shared'

/**
 * Куда доставлять исходящее Telegram-сообщение по вернувшемуся на дожим лиду.
 *
 * Дожим («Доработки») — единственный случай, когда менеджер пишет в переданный
 * (curator_id) диалог. Если наш исходный аккаунт у этого контакта в ЧС
 * (contactBlocked) ИЛИ канал не в сети / забанен / ограничен, обычная отправка
 * всё равно не дойдёт — поэтому НЕЗАМЕТНО уходим с общего аккаунта для
 * исходящих (getOutreachChannel). Для менеджера это прозрачно: он видит обычную
 * успешную отправку в том же треде; факт подмены пишем только в журнал аудита.
 *
 * Возвращает канал/владельца/цель для enqueue. По умолчанию — исходный канал.
 * Подмену делаем только для переданных диалогов (дожим), чтобы не менять
 * поведение обычной отправки.
 */
async function resolveTelegramDelivery(
  conv: Conversation,
  actor: { id: string; name: string },
): Promise<{ channelId: string; managerId: string | null; target: string }> {
  const fallback = {
    channelId: conv.channelId,
    managerId: actor.id,
    target: conv.contactHandle,
  }
  if (!conv.transferred) return fallback

  const owning = await getChannelById(conv.channelId)
  if (!isTelegramDeliveryImpaired(owning, Boolean(conv.contactBlocked))) {
    return fallback
  }

  const outreach = await getOutreachChannel()
  if (
    !outreach ||
    outreach.status !== 'connected' ||
    outreach.id === conv.channelId
  ) {
    return fallback
  }

  await writeAudit({
    actorRole: 'manager',
    actorId: actor.id,
    actorLabel: actor.name,
    action: 'conversation.rework_fallback',
    entityType: 'conversation',
    entityId: conv.id,
    details: {
      reason: conv.contactBlocked ? 'contact_blocked' : 'channel_offline',
      fromChannelId: conv.channelId,
      viaChannelId: outreach.id,
    },
  }).catch(() => {})

  // Первый контакт с общего аккаунта резолвится по @username надёжнее числового
  // id (у outreach-аккаунта нет access_hash на этот контакт).
  return {
    channelId: outreach.id,
    managerId: outreach.managerId,
    target: conv.contactUsername
      ? `@${conv.contactUsername}`
      : conv.contactHandle,
  }
}

export async function sendMessageAction(
  conversationId: string,
  body: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  const text = body.trim()
  if (!text) return { ok: false, message: 'Сообщение пустое.' }

  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: text,
    author: session.name,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  // Delivery routing by channel:
  //  • Telegram: worker job queue (MTProto session).
  //  • WhatsApp Cloud API: direct Graph API call (no worker/session).
  //  • MAX / VK: direct Bot API call.
  //  • Live chat: no delivery — the inserted 'out' row fires a realtime NOTIFY
  //    that the website widget receives over its SSE stream.
  const conv = await getConversation(conversationId, session.sub)
  if (conv && conv.channelType === 'whatsapp') {
    // WhatsApp is Cloud API only (Baileys was removed). If delivery reports the
    // conversation isn't a configured Cloud channel, the token is missing/broken
    // — fail the row loudly instead of leaving it stuck "sending".
    const handled = await deliverWhatsappMessage(conversationId, msg.id, text)
    if (!handled) {
      await markMessageFailed(
        msg.id,
        'WhatsApp не настроен: добавьте токен доступа в админке (аккаунты → WhatsApp).',
      ).catch(() => {})
      revalidatePath('/app/inbox')
      return {
        ok: false,
        message: 'WhatsApp не настроен — обратитесь к администратору.',
      }
    }
  } else if (conv && conv.channelType === 'telegram') {
    // Resolve the sending account: for a returned-for-follow-up («Доработки»)
    // lead whose original account is blocked/offline, this silently swaps to
    // the shared outreach account. Transparent to the manager.
    const delivery = await resolveTelegramDelivery(conv, {
      id: session.sub,
      name: session.name,
    })
    try {
      await enqueueJob({
        channelId: delivery.channelId,
        managerId: delivery.managerId,
        action: 'send_message',
        // Pass the optimistic row id so the worker can backfill the provider
        // message id and attach delivery/read receipts — and flag the row
        // 'failed' if the send is rejected.
        payload: { target: delivery.target, body: text, messageId: msg.id },
      })
    } catch (err) {
      // If we can't even queue the job, the worker will never see this message.
      // Don't tell the operator it was "sent" — flag the row failed and report
      // the failure, mirroring the WhatsApp branch above.
      console.error('[panel] failed to enqueue send_message job:', err)
      await markMessageFailed(
        msg.id,
        'Не удалось поставить сообщение в очередь. Попробуйте ещё раз.',
      ).catch(() => {})
      revalidatePath('/app/inbox')
      return {
        ok: false,
        message: 'Не удалось отправить — сообщение не поставлено в очередь.',
      }
    }
  } else if (conv && conv.channelType === 'max') {
    // Push straight to MAX and backfill the provider id (or flag failed).
    await deliverMaxMessage(conversationId, msg.id, text)
  } else if (conv && conv.channelType === 'vk') {
    // Push straight to VK and backfill the provider id (or flag failed).
    await deliverVkMessage(conversationId, msg.id, text)
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Отправлено.' }
}

/**
 * «Доработки»: менеджер убирает вернувшийся на дожим лид «в trash» — карточка
 * исчезает из раздела. Терминальное менеджерское действие; кураторский статус
 * лида не трогается. Скоуп — по владельцу диалога (manager_id), чужой лид не
 * тронуть.
 */
export async function trashReworkLeadAction(
  conversationId: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  const ok = await trashReworkLead(conversationId, session.sub)
  if (!ok) {
    return { ok: false, message: 'Лид не найден или уже убран.' }
  }
  await writeAudit({
    actorRole: 'manager',
    actorId: session.sub,
    actorLabel: session.name,
    action: 'lead.rework_trashed',
    entityType: 'conversation',
    entityId: conversationId,
  }).catch(() => {})
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Лид убран из «Доработок».' }
}

/**
 * Mark a conversation as read: clears our unread counter and, for
 * Telegram/WhatsApp, tells the worker to send read receipts so the contact sees
 * our messages were read. Best-effort and safe to call repeatedly (e.g. each
 * time the operator opens a chat).
 */
export async function markConversationReadAction(
  conversationId: string,
): Promise<SimpleResult> {
  const session = await requireManager()

  const conv = await markConversationRead(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }

  if (conv.channelType === 'whatsapp') {
    // Cloud API sends the read receipt directly. Best-effort: if the channel
    // isn't a configured Cloud number there's nothing to ack (no Baileys
    // fallback anymore), so we simply skip — read receipts are non-critical.
    await markWhatsappConversationRead(conversationId)
  } else if (conv.channelType === 'telegram') {
    await enqueueJob({
      channelId: conv.channelId,
      managerId: session.sub,
      action: 'mark_read',
      payload: { target: conv.contactHandle },
    }).catch((err) => {
      console.error('[panel] failed to enqueue mark_read job:', err)
    })
  } else if (conv.channelType === 'vk') {
    // VK sends the read receipt directly through the account's proxy.
    await markVkConversationRead(conversationId)
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Прочитано.' }
}

/**
 * Schedule a message for later delivery (Telegram only). Telegram schedules
 * the send SERVER-SIDE (messages.sendMessage schedule_date), so it delivers at
 * the chosen time even if the panel and worker are offline. The message row is
 * recorded immediately (so the manager sees what was queued); the worker
 * backfills the provider id when Telegram accepts the schedule.
 */
export async function sendScheduledMessageAction(
  conversationId: string,
  body: string,
  scheduleAtIso: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  const text = body.trim()
  if (!text) return { ok: false, message: 'Сообщение пустое.' }

  const scheduleAt = new Date(scheduleAtIso)
  const nowMs = Date.now()
  if (Number.isNaN(scheduleAt.getTime())) {
    return { ok: false, message: 'Некорректная дата.' }
  }
  // At least 2 minutes out (Telegram rejects near-past schedule dates) and at
  // most 365 days (Telegram's own scheduling horizon).
  if (scheduleAt.getTime() < nowMs + 2 * 60_000) {
    return { ok: false, message: 'Время должно быть минимум через 2 минуты.' }
  }
  if (scheduleAt.getTime() > nowMs + 365 * 24 * 3_600_000) {
    return { ok: false, message: 'Максимум — год вперёд.' }
  }

  const conv = await getConversation(conversationId, session.sub)
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
    managerId: session.sub,
    body: text,
    preview: `[Запланировано на ${when}] ${text}`,
    author: session.name,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  try {
    await enqueueJob({
      channelId: conv.channelId,
      managerId: session.sub,
      action: 'send_message',
      payload: {
        target: conv.contactHandle,
        body: text,
        messageId: msg.id,
        scheduleAt: Math.floor(scheduleAt.getTime() / 1000),
      },
    })
  } catch (err) {
    console.error('[panel] failed to enqueue scheduled send_message job:', err)
    await markMessageFailed(
      msg.id,
      'Не удалось поставить сообщение в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath('/app/inbox')
    return { ok: false, message: 'Не удалось запланировать отправку.' }
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: `Запланировано на ${when} (МСК).` }
}

/**
 * Hard cap on a recorded voice note (bytes of the encoded audio, pre-base64).
 * ~1 MB of opus/webm ≈ 60–90 seconds of speech — enough for a voice reply
 * while keeping job payloads comfortably small for the Postgres job queue.
 */
const VOICE_MAX_BYTES = 1_048_576

/**
 * Send a voice note recorded in the panel composer (Telegram only). Records an
 * outgoing 'voice' message for instant display, then enqueues a send_voice job
 * carrying the audio as base64; the worker delivers it as a native Telegram
 * voice bubble (waveform + duration).
 */
export async function sendVoiceAction(
  conversationId: string,
  audio: { base64: string; mime: string; durationSec: number },
): Promise<SimpleResult> {
  const session = await requireManager()
  if (!audio?.base64) return { ok: false, message: 'Пустая запись.' }
  // base64 inflates by 4/3 — compare against the decoded size.
  const approxBytes = Math.floor(audio.base64.length * 0.75)
  if (approxBytes > VOICE_MAX_BYTES) {
    return { ok: false, message: 'Запись слишком длинная (лимит ~1 МБ).' }
  }
  const durationSec = Math.min(600, Math.max(1, Math.round(audio.durationSec)))

  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'telegram') {
    return { ok: false, message: 'Голосовые доступны только для Telegram.' }
  }

  // Record the outgoing voice row so it appears in the thread immediately; the
  // provider id is backfilled by the worker after the actual send, and a
  // rejected send flags this row 'failed' with the reason.
  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: '[Голосовое сообщение]',
    author: session.name,
    mediaType: 'voice',
    mediaMime: audio.mime || 'audio/ogg',
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  try {
    await enqueueJob({
      channelId: conv.channelId,
      managerId: session.sub,
      action: 'send_voice',
      payload: {
        target: conv.contactHandle,
        audio: audio.base64,
        durationSec,
        messageId: msg.id,
      },
    })
  } catch (err) {
    console.error('[panel] failed to enqueue send_voice job:', err)
    await markMessageFailed(
      msg.id,
      'Не удалось поставить голосовое в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath('/app/inbox')
    return { ok: false, message: 'Не удалось отправить голосовое.' }
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Голосовое отправлено.' }
}

/**
 * Send a sticker (Telegram only). Records an outgoing 'sticker' message for
 * instant display, then enqueues a send_sticker job for the worker to deliver
 * via MTProto.
 */
export async function sendStickerAction(
  conversationId: string,
  sticker: StickerItem,
): Promise<SimpleResult> {
  const session = await requireManager()
  if (!sticker || !sticker.id || !sticker.accessHash || !sticker.fileReference) {
    return { ok: false, message: 'Некорректный стикер.' }
  }

  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'telegram') {
    return { ok: false, message: 'Стикеры доступны только для Telegram.' }
  }

  // Record the outgoing sticker so it appears immediately in the thread. The
  // body carries the emoji (or a placeholder) for previews / accessibility.
  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: sticker.emoji || '[Стикер]',
    author: session.name,
    mediaType: 'sticker',
    mediaMime: sticker.mime || 'image/webp',
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  await enqueueJob({
    channelId: conv.channelId,
    managerId: session.sub,
    action: 'send_sticker',
    payload: {
      target: conv.contactHandle,
      documentId: sticker.id,
      accessHash: sticker.accessHash,
      fileReference: sticker.fileReference,
      emoji: sticker.emoji,
    },
  }).catch((err) => {
    console.error('[panel] failed to enqueue send_sticker job:', err)
  })

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Стикер отправлен.' }
}
