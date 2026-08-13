'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  addMessage,
  enqueueJob,
  findOrCreateOutreachConversation,
  getOutreachChannel,
  markMessageFailed,
} from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'

export interface OutreachResult {
  ok: boolean
  message: string
  /** Id of the (created or reused) conversation so the UI can open it. */
  conversationId?: string
}

/**
 * Есть ли назначенный админом Telegram-аккаунт для исходящих. Определяет,
 * показывать ли менеджеру кнопку «Написать в Telegram» в карточке лида.
 */
export async function isOutreachAvailableAction(): Promise<boolean> {
  await requireManager()
  const ch = await getOutreachChannel()
  return Boolean(ch && ch.status === 'connected')
}

/**
 * Менеджер сам пишет лиду в Telegram ПЕРВЫМ — с выделенного админом
 * аккаунта (не с личного/случайного). Сценарий: лид пришёл из VK со своего
 * личного аккаунта и не хочет продолжать там — менеджер выходит на его
 * Telegram, но строго с рабочего аккаунта компании.
 *
 * Диалог создаётся в инбоксе ДЕЙСТВУЮЩЕГО менеджера на outreach-канале и
 * дальше живёт как обычный Telegram-диалог (очередь, статусы, дожим).
 * `telegramId` (числовой) предпочтительнее username: воркер ключует входящие
 * по числовому id, так ответ лида попадёт в этот же тред.
 */
export async function startTelegramOutreachAction(input: {
  /** @username лида (с @ или без). */
  username?: string
  /** Числовой Telegram ID лида, если известен. */
  telegramId?: string
  contactName?: string
  message: string
}): Promise<OutreachResult> {
  const session = await requireManager()

  const text = (input.message ?? '').trim()
  if (!text) return { ok: false, message: 'Напишите текст сообщения.' }

  const username = (input.username ?? '').trim().replace(/^@+/, '')
  const telegramId = (input.telegramId ?? '').trim()
  if (!username && !/^\d+$/.test(telegramId)) {
    return {
      ok: false,
      message: 'Укажите @username или числовой Telegram ID лида.',
    }
  }

  const channel = await getOutreachChannel()
  if (!channel) {
    return {
      ok: false,
      message:
        'Аккаунт для исходящих не назначен. Попросите администратора выбрать его в разделе «Аккаунты».',
    }
  }
  if (channel.status !== 'connected') {
    return {
      ok: false,
      message: `Аккаунт для исходящих («${channel.name}») сейчас не в сети. Попробуйте позже.`,
    }
  }

  // Числовой id — канонический ключ входящих у воркера; username — фолбэк.
  const handle = /^\d+$/.test(telegramId) ? telegramId : username
  const target = /^\d+$/.test(telegramId) ? telegramId : `@${username}`
  const contactName =
    (input.contactName ?? '').trim() || (username ? `@${username}` : handle)

  const conv = await findOrCreateOutreachConversation({
    channelId: channel.id,
    managerId: session.sub,
    contactName,
    handle,
  })
  if (!conv) {
    return { ok: false, message: 'Не удалось создать диалог. Попробуйте ещё раз.' }
  }
  if (conv.foreign) {
    return {
      ok: false,
      message:
        'С этим контактом уже ведёт переписку другой менеджер с рабочего аккаунта.',
    }
  }

  const msg = await addMessage({
    conversationId: conv.id,
    managerId: session.sub,
    body: text,
    author: session.name,
  })
  if (!msg) return { ok: false, message: 'Не удалось отправить сообщение.' }

  try {
    await enqueueJob({
      channelId: channel.id,
      managerId: session.sub,
      action: 'send_message',
      payload: { target, body: text, messageId: msg.id },
    })
  } catch (err) {
    // Джоба не встала в очередь — воркер её никогда не отправит. Честно
    // помечаем сообщение проваленным вместо ложного «отправлено».
    console.error('[panel] failed to enqueue outreach job:', err)
    await markMessageFailed(
      msg.id,
      'Не удалось поставить отправку в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath('/app/inbox')
    return {
      ok: false,
      message: 'Не удалось отправить — сообщение не поставлено в очередь.',
      conversationId: conv.id,
    }
  }

  await writeAudit({
    actorRole: 'manager',
    actorId: session.sub,
    actorLabel: session.name,
    action: 'conversation.outreach',
    entityType: 'conversation',
    entityId: conv.id,
    details: { channelId: channel.id, viaUsername: !(/^\d+$/.test(telegramId)) },
  }).catch(() => {})

  revalidatePath('/app/inbox')
  return {
    ok: true,
    message: `Сообщение отправлено с аккаунта «${channel.name}». Диалог появился в вашем инбоксе.`,
    conversationId: conv.id,
  }
}
