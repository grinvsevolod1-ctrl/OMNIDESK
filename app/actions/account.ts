'use server'

import { revalidatePath } from 'next/cache'
import {
  comparePassword,
  hashPassword,
  requireManager,
  startSession,
} from '@/lib/auth'
import {
  addMessage,
  enqueueJob,
  getConversation,
  getManagerAuthState,
  getManagerByEmail,
  getManagerOnLunch,
  getVkDispatchByConversationId,
  getWhatsappCloudDispatchByConversationId,
  markConversationRead,
  markMessageFailed,
  setManagerOnLunch,
  setMessageProviderId,
  tryGoOnLunch,
  updateManagerPassword,
} from '@/lib/data'
import { deliverMaxMessage } from '@/lib/max-dispatch'
import { deliverVkMessage, markVkConversationRead } from '@/lib/vk-dispatch'
import {
  sendMessage as sendVkMessage,
  uploadDocAttachment as uploadVkDoc,
  uploadPhotoAttachment as uploadVkPhoto,
} from '@/lib/vk'
import {
  deliverWhatsappMessage,
  markWhatsappConversationRead,
} from '@/lib/whatsapp-dispatch'
import {
  sendMedia,
  uploadMedia,
  type WaMediaKind,
} from '@/lib/whatsapp-cloud'
import type { MediaType, StickerItem } from '@/lib/types'

export interface SimpleResult {
  ok: boolean
  message: string
}

/**
 * Toggle the calling manager's "on lunch" availability. While on lunch, NEW
 * conversations are routed (round-robin) to other available managers; existing
 * conversations stay put. Returns the resulting state so the UI stays in sync.
 */
export async function setLunchAction(
  onLunch: boolean,
): Promise<{ ok: boolean; onLunch: boolean; message: string }> {
  const session = await requireManager()

  if (onLunch) {
    // Atomic guard: check-and-set runs in ONE transaction under an advisory
    // lock (tryGoOnLunch), so simultaneous clicks are serialized and the last
    // available manager is always blocked. The previous two-query version
    // raced: everyone pressing "lunch" at the same minute passed the check
    // together and the whole team could walk out at once.
    let allowed: boolean
    try {
      allowed = await tryGoOnLunch(session.sub)
    } catch (err) {
      // Fail CLOSED for going on lunch: if we can't verify availability,
      // don't risk leaving the line unmanned.
      console.error('[panel] setLunchAction (go on lunch) failed:', err)
      return {
        ok: false,
        onLunch: false,
        message: 'Не удалось обновить статус.',
      }
    }
    if (!allowed) {
      return {
        ok: false,
        onLunch: false,
        message:
          'Вы сейчас единственный менеджер на линии. Дождитесь, пока вернётся кто-то ещё, прежде чем уходить на обед.',
      }
    }
  } else {
    // Coming BACK from lunch is always allowed — never trap a manager away.
    try {
      await setManagerOnLunch(session.sub, false)
    } catch (err) {
      console.error('[panel] setLunchAction (return) failed:', err)
      return {
        ok: false,
        onLunch: true,
        message: 'Не удалось обновить статус.',
      }
    }
  }
  // The inbox lists conversations for this manager; refresh after a change.
  revalidatePath('/app/inbox')
  return {
    ok: true,
    onLunch,
    message: onLunch
      ? 'Вы на обеде — новые диалоги уйдут другим менеджерам.'
      : 'Вы снова на линии.',
  }
}

/** Read the calling manager's current "on lunch" flag (for initial UI state). */
export async function getLunchStateAction(): Promise<boolean> {
  const session = await requireManager()
  return getManagerOnLunch(session.sub)
}

export async function changeOwnPasswordAction(
  formData: FormData,
): Promise<SimpleResult> {
  const session = await requireManager()
  const current = String(formData.get('current') ?? '')
  const next = String(formData.get('next') ?? '')

  if (next.length < 8) {
    return { ok: false, message: 'Новый пароль должен быть не короче 8 символов.' }
  }
  const manager = await getManagerByEmail(session.email)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }

  const ok = await comparePassword(current, manager.passwordHash)
  if (!ok) return { ok: false, message: 'Текущий пароль неверен.' }

  await updateManagerPassword(manager.id, await hashPassword(next))

  // updateManagerPassword bumps session_version, which would invalidate THIS
  // manager's own cookie. Re-issue the session with the fresh version so the
  // user who just changed their password stays signed in, while every other
  // outstanding session (e.g. on another device) is forced to re-authenticate.
  const fresh = await getManagerAuthState(manager.id)
  await startSession({
    sub: manager.id,
    role: 'manager',
    email: manager.email,
    name: manager.name,
    sv: fresh?.sessionVersion ?? 0,
  })

  return { ok: true, message: 'Пароль обновлён.' }
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
    try {
      await enqueueJob({
        channelId: conv.channelId,
        managerId: session.sub,
        action: 'send_message',
        // Pass the optimistic row id so the worker can backfill the provider
        // message id and attach delivery/read receipts — and flag the row
        // 'failed' if the send is rejected.
        payload: { target: conv.contactHandle, body: text, messageId: msg.id },
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
 * Per-kind upload size caps (Cloud API limits). Documents allow the most;
 * images/audio/video are smaller. Stickers must be tiny WebP.
 */
const WA_MEDIA_LIMITS: Record<WaMediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  sticker: 100 * 1024,
}

const MEDIA_KIND_LABEL: Record<MediaType, string> = {
  image: '[Фото]',
  video: '[Видео]',
  video_note: '[Видео]',
  audio: '[Аудио]',
  voice: '[Голосовое сообщение]',
  sticker: '[Стикер]',
  document: '[Документ]',
}

/**
 * Decide how to classify an upload by its MIME type. Returns the Cloud API
 * media kind (how we send it) plus our internal MediaType (how the panel renders
 * it). Anything unrecognised is treated as a document.
 */
function classifyUpload(mime: string): { kind: WaMediaKind; mediaType: MediaType } {
  if (mime.startsWith('image/')) {
    return mime === 'image/webp'
      ? { kind: 'sticker', mediaType: 'sticker' }
      : { kind: 'image', mediaType: 'image' }
  }
  if (mime.startsWith('video/')) return { kind: 'video', mediaType: 'video' }
  if (mime.startsWith('audio/')) return { kind: 'audio', mediaType: 'audio' }
  return { kind: 'document', mediaType: 'document' }
}

/**
 * Send a media file on a WhatsApp Cloud conversation. The browser posts the file
 * via FormData; we upload the bytes to the Graph API, send the media message,
 * and record an outbound row (with a `waMediaId` so the panel can re-display it
 * through /api/media). Delivery ticks are backfilled by the status webhook; a
 * rejected send is flagged 'failed'. Only inside the 24h service window.
 */
export async function sendWhatsappMediaAction(
  conversationId: string,
  formData: FormData,
): Promise<SimpleResult> {
  const session = await requireManager()

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Файл не выбран.' }
  }
  const caption = String(formData.get('caption') ?? '').trim()

  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'whatsapp') {
    return { ok: false, message: 'Вложения доступны только для WhatsApp.' }
  }

  const mime = file.type || 'application/octet-stream'
  const { kind, mediaType } = classifyUpload(mime)
  if (file.size > WA_MEDIA_LIMITS[kind]) {
    const mb = Math.round(WA_MEDIA_LIMITS[kind] / (1024 * 1024))
    return { ok: false, message: `Файл слишком большой (максимум ${mb} МБ).` }
  }

  const dispatch = await getWhatsappCloudDispatchByConversationId(conversationId)
  if (!dispatch) {
    return { ok: false, message: 'WhatsApp не настроен — добавьте токен в админке.' }
  }

  // 1) Upload the bytes to WhatsApp → media id.
  const up = await uploadMedia(
    dispatch.phoneNumberId,
    dispatch.token,
    file,
    mime,
    file.name || 'file',
    dispatch.proxy,
  )
  if (!up.ok) {
    console.error('[panel] whatsapp media upload failed:', up.error)
    return { ok: false, message: 'Не удалось загрузить файл в WhatsApp.' }
  }

  // 2) Record the outbound row immediately so it shows in the thread.
  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: caption,
    preview: caption || MEDIA_KIND_LABEL[mediaType],
    author: session.name,
    mediaType,
    mediaMime: mime,
    mediaName: kind === 'document' ? file.name || undefined : undefined,
    mediaRef: { waMediaId: up.data.id },
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  // 3) Send the media message; backfill the provider id or flag failed.
  const sent = await sendMedia(
    dispatch.phoneNumberId,
    dispatch.token,
    dispatch.contactHandle,
    kind,
    up.data.id,
    caption || undefined,
    file.name || undefined,
    dispatch.proxy,
  )
  if (!sent.ok) {
    console.error('[panel] whatsapp media send failed:', sent.error)
    await markMessageFailed(msg.id, sent.error).catch(() => {})
    revalidatePath('/app/inbox')
    return {
      ok: false,
      message:
        sent.status === 470 || /window/i.test(sent.error)
          ? 'Окно 24 часов закрыто — клиент должен написать первым.'
          : 'Файл сохранён, но WhatsApp отклонил отправку.',
    }
  }
  const mid = sent.data.messages?.[0]?.id
  if (mid) await setMessageProviderId(msg.id, mid).catch(() => {})

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Файл отправлен.' }
}

/**
 * Per-kind upload size caps for VK. VK allows large docs; we keep sane limits so
 * a huge upload can't tie up the account's proxy.
 */
const VK_MEDIA_LIMITS = {
  photo: 25 * 1024 * 1024,
  doc: 200 * 1024 * 1024,
}

/**
 * Send a media file on a VK conversation. Static images (except GIFs) upload as
 * a VK photo; everything else uploads as a VK document. The bytes are uploaded
 * through the account's proxy, an outbound row is recorded for instant display
 * (with the returned CDN url in media_ref), then messages.send delivers it —
 * backfilling the provider id or flagging the row 'failed' with VK's reason.
 */
export async function sendVkMediaAction(
  conversationId: string,
  formData: FormData,
): Promise<SimpleResult> {
  const session = await requireManager()

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Файл не выбран.' }
  }
  const caption = String(formData.get('caption') ?? '').trim()

  const conv = await getConversation(conversationId, session.sub)
  if (!conv) return { ok: false, message: 'Диалог не найден.' }
  if (conv.channelType !== 'vk') {
    return { ok: false, message: 'Это действие доступно только для VK.' }
  }

  const mime = file.type || 'application/octet-stream'
  // VK photo upload only accepts static raster images; GIFs and everything else
  // must go through the document uploader.
  const asPhoto = mime.startsWith('image/') && mime !== 'image/gif'
  const cap = asPhoto ? VK_MEDIA_LIMITS.photo : VK_MEDIA_LIMITS.doc
  if (file.size > cap) {
    const mb = Math.round(cap / (1024 * 1024))
    return { ok: false, message: `Файл слишком большой (максимум ${mb} МБ).` }
  }

  const dispatch = await getVkDispatchByConversationId(conversationId)
  if (!dispatch) {
    return { ok: false, message: 'VK не настроен для этого диалога.' }
  }

  // 1) Upload the bytes to VK → attachment descriptor (+ display url).
  const up = asPhoto
    ? await uploadVkPhoto(
        dispatch.channel.token,
        dispatch.contactHandle,
        file,
        file.name || 'photo.jpg',
        dispatch.proxy,
      )
    : await uploadVkDoc(
        dispatch.channel.token,
        dispatch.contactHandle,
        file,
        file.name || 'file',
        dispatch.proxy,
      )
  if (!up.ok) {
    console.error('[panel] vk media upload failed:', up.error)
    return { ok: false, message: up.error || 'Не удалось загрузить файл в VK.' }
  }

  const mediaType: MediaType = asPhoto ? 'image' : 'document'
  // 2) Record the outbound row immediately so it shows in the thread.
  const msg = await addMessage({
    conversationId,
    managerId: session.sub,
    body: caption,
    preview: caption || MEDIA_KIND_LABEL[mediaType],
    author: session.name,
    mediaType,
    mediaMime: mime,
    mediaName: asPhoto ? undefined : file.name || undefined,
    mediaRef: up.data.url ? { url: up.data.url } : undefined,
  })
  if (!msg) return { ok: false, message: 'Диалог не найден.' }

  // 3) Send the message with the attachment; backfill provider id or fail.
  const sent = await sendVkMessage(
    dispatch.channel.token,
    dispatch.contactHandle,
    caption,
    dispatch.proxy,
    up.data.attachment,
  )
  if (!sent.ok) {
    console.error('[panel] vk media send failed:', sent.error)
    await markMessageFailed(msg.id, sent.error).catch(() => {})
    revalidatePath('/app/inbox')
    return { ok: false, message: sent.error || 'VK отклонил отправку файла.' }
  }
  if (sent.data.messageId) {
    await setMessageProviderId(msg.id, sent.data.messageId).catch(() => {})
  }

  revalidatePath('/app/inbox')
  return { ok: true, message: 'Отправлено.' }
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
