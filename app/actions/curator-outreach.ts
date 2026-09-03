'use server'

import { revalidatePath } from 'next/cache'
import { requireCurator } from '@/lib/auth'
import {
  addMessage,
  enqueueJob,
  findOrCreateCuratorOutreachConversation,
  getOutreachChannel,
  markMessageFailed,
} from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'

const CURATOR_CHATS_PATH = '/curator/chats'

export interface CuratorOutreachResult {
  ok: boolean
  message: string
  /** Id of the (created or reused) conversation so the UI can open it. */
  conversationId?: string
  /** True when we opened an EXISTING dialog instead of sending a new message. */
  alreadyExists?: boolean
}

/**
 * Есть ли назначенный админом Telegram-аккаунт для исходящих. Определяет,
 * показывать ли куратору кнопку «Написать в Telegram» в разделе «Чаты».
 */
export async function isCuratorOutreachAvailableAction(): Promise<boolean> {
  await requireCurator()
  const ch = await getOutreachChannel()
  return Boolean(ch && ch.status === 'connected')
}

/**
 * Куратор сам пишет контакту в Telegram ПЕРВЫМ — с выделенного админом
 * аккаунта для исходящих (не с личного). Полное зеркало менеджерского
 * startTelegramOutreachAction, но диалог создаётся сразу привязанным к куратору
 * (curator_id = session.sub): он появляется в разделе «Чаты» куратора и
 * ведётся им. Владелец канала (manager_id) — тот же outreach-аккаунт, доставка
 * идёт через воркер под ним; своего Telegram-аккаунта у куратора нет.
 */
export async function startCuratorTelegramOutreachAction(input: {
  /** @username контакта (с @ или без). */
  username?: string
  /** Числовой Telegram ID контакта, если известен. */
  telegramId?: string
  contactName?: string
  message: string
}): Promise<CuratorOutreachResult> {
  const session = await requireCurator()

  const text = (input.message ?? '').trim()
  if (!text) return { ok: false, message: 'Напишите текст сообщения.' }

  const username = (input.username ?? '').trim().replace(/^@+/, '')
  const telegramId = (input.telegramId ?? '').trim()
  if (!username && !/^\d+$/.test(telegramId)) {
    return {
      ok: false,
      message: 'Укажите @username или числовой Telegram ID контакта.',
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

  const hasId = /^\d+$/.test(telegramId)

  // Ключ диалога — числовой id (воркер ключует ВХОДЯЩИЕ по нему, ответ попадёт
  // в этот тред); цель ОТПРАВКИ — @username, когда он есть (для первого контакта
  // числовой id может не резолвиться без access_hash, username Telegram резолвит
  // сам).
  const handle = hasId ? telegramId : username
  const target = username ? `@${username}` : telegramId
  const contactName =
    (input.contactName ?? '').trim() || (username ? `@${username}` : handle)

  const conv = await findOrCreateCuratorOutreachConversation({
    channelId: channel.id,
    managerId: channel.managerId ?? '',
    curatorId: session.sub,
    contactName,
    handle,
  })
  if (!conv) {
    return { ok: false, message: 'Не удалось создать диалог. Попробуйте ещё раз.' }
  }
  if (conv.foreign) {
    return {
      ok: false,
      message: 'С этим контактом уже ведёт переписку другой сотрудник.',
    }
  }

  const msg = await addMessage({
    conversationId: conv.id,
    managerId: channel.managerId ?? '',
    curatorId: session.sub,
    body: text,
    author: session.name,
  })
  if (!msg) return { ok: false, message: 'Не удалось отправить сообщение.' }

  try {
    await enqueueJob({
      channelId: channel.id,
      managerId: channel.managerId ?? null,
      action: 'send_message',
      payload: { target, body: text, messageId: msg.id },
    })
  } catch (err) {
    console.error('[panel] failed to enqueue curator outreach job:', err)
    await markMessageFailed(
      msg.id,
      'Не удалось поставить отправку в очередь. Попробуйте ещё раз.',
    ).catch(() => {})
    revalidatePath(CURATOR_CHATS_PATH)
    return {
      ok: false,
      message: 'Не удалось отправить — сообщение не поставлено в очередь.',
      conversationId: conv.id,
    }
  }

  await writeAudit({
    actorRole: 'curator',
    actorId: session.sub,
    actorLabel: session.name,
    action: 'conversation.outreach',
    entityType: 'conversation',
    entityId: conv.id,
    details: { channelId: channel.id, viaUsername: !hasId },
  }).catch(() => {})

  revalidatePath(CURATOR_CHATS_PATH)
  return {
    ok: true,
    message: `Сообщение отправлено с аккаунта «${channel.name}». Диалог появился в разделе «Чаты».`,
    conversationId: conv.id,
  }
}
