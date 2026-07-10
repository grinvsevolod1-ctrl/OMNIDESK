'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { query } from '@/lib/db'
import {
  createChannel,
  deleteChannelById,
  updateManagerStatus,
} from '@/lib/data'
import type { ChannelType, ManagerStatus } from '@/lib/types'

/**
 * Server actions backing the God-mode admin console at /wijegniwjgwjog.
 *
 * Every action re-checks `requireAdmin()` on the server — the page guard is not
 * enough on its own, because a server action is an independent POST endpoint
 * that an attacker could call directly. All mutations funnel through the same
 * parameterised `query`/`lib/data` helpers used everywhere else (no string
 * interpolation into SQL), and each revalidates the page so the RSC re-renders
 * with fresh data instead of relying on client-side cache juggling.
 */

const ADMIN_PATH = '/wijegniwjgwjog'

export interface ActionResult {
  ok: boolean
  message: string
}

const CHANNEL_TYPES: ChannelType[] = [
  'telegram',
  'whatsapp',
  'vk',
  'max',
  'livechat',
]

const CONVERSATION_STATUSES = [
  'liquid',
  'not_liquid',
  'unsubscribed',
  'transferred',
] as const

export async function secretCreateChannelAction(input: {
  name: string
  type: string
  managerId: string
  phone?: string
  token?: string
  groupId?: string
}): Promise<ActionResult> {
  await requireAdmin()

  const name = input.name?.trim()
  const type = input.type as ChannelType
  if (!name) return { ok: false, message: 'Укажите название канала' }
  if (!CHANNEL_TYPES.includes(type))
    return { ok: false, message: 'Неизвестный тип канала' }
  if (!input.managerId)
    return { ok: false, message: 'Выберите менеджера-владельца' }

  const config: Record<string, unknown> = {}
  if (input.token) config.token = input.token.trim()
  if (input.groupId) config.groupId = input.groupId.trim()
  if (type === 'whatsapp' && input.phone)
    config.phoneNumberId = input.phone.trim()

  try {
    await createChannel({
      managerId: input.managerId,
      type,
      name,
      detail: input.phone?.trim() || `${type} канал`,
      status: 'connected',
      sessionStatus: 'online',
      phone: type === 'telegram' || type === 'whatsapp' ? input.phone ?? null : null,
      config,
    })
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Не удалось создать канал',
    }
  }

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: `Канал «${name}» создан` }
}

export async function secretDeleteChannelAction(
  id: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан канал' }
  await deleteChannelById(id)
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Канал удалён' }
}

export async function secretSetChannelStatusAction(
  id: string,
  status: string,
): Promise<ActionResult> {
  await requireAdmin()
  const allowed = ['connected', 'pending', 'error', 'disconnected']
  if (!id || !allowed.includes(status))
    return { ok: false, message: 'Некорректный статус' }
  await query(
    'UPDATE channels SET status = $2, last_checked_at = now() WHERE id = $1',
    [id, status],
  )
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Статус канала обновлён' }
}

export async function secretToggleChannelIngestAction(
  id: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан канал' }
  const rows = await query<{ ingest_paused: boolean }>(
    'UPDATE channels SET ingest_paused = NOT ingest_paused WHERE id = $1 RETURNING ingest_paused',
    [id],
  )
  if (!rows[0]) return { ok: false, message: 'Канал не найден' }
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: rows[0].ingest_paused
      ? 'Приём сообщений приостановлен'
      : 'Приём сообщений возобновлён',
  }
}

export async function secretCreateConversationAction(input: {
  channelId: string
  contactName: string
  contactHandle: string
  message?: string
}): Promise<ActionResult> {
  await requireAdmin()

  const contactName = input.contactName?.trim()
  const contactHandle = input.contactHandle?.trim()
  if (!input.channelId || !contactName || !contactHandle)
    return { ok: false, message: 'Заполните канал, имя и хэндл контакта' }

  const channel = await query<{ id: string; type: string; manager_id: string | null }>(
    'SELECT id, type, manager_id FROM channels WHERE id = $1 LIMIT 1',
    [input.channelId],
  )
  if (!channel[0]) return { ok: false, message: 'Канал не найден' }
  if (!channel[0].manager_id)
    return {
      ok: false,
      message: 'У канала нет владельца — назначьте менеджера перед созданием диалога',
    }

  const id = randomUUID()
  const firstMessage = input.message?.trim() ?? ''
  await query(
    `INSERT INTO conversations
       (id, channel_id, channel_type, manager_id, contact_name, contact_handle, last_message, last_message_at, status, unread)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'liquid', $8)`,
    [
      id,
      channel[0].id,
      channel[0].type,
      channel[0].manager_id,
      contactName,
      contactHandle,
      firstMessage,
      firstMessage ? 1 : 0,
    ],
  )

  if (firstMessage) {
    await query(
      `INSERT INTO messages (id, conversation_id, direction, body, author)
       VALUES ($1, $2, 'in', $3, $4)`,
      [randomUUID(), id, firstMessage, contactName],
    )
  }

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: `Диалог с «${contactName}» создан` }
}

export async function secretDeleteConversationAction(
  id: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан диалог' }
  await query('DELETE FROM conversations WHERE id = $1', [id])
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Диалог удалён' }
}

export async function secretSetConversationStatusAction(
  id: string,
  status: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id || !CONVERSATION_STATUSES.includes(status as (typeof CONVERSATION_STATUSES)[number]))
    return { ok: false, message: 'Некорректный статус диалога' }
  await query('UPDATE conversations SET status = $2 WHERE id = $1', [id, status])
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Статус диалога обновлён' }
}

export async function secretSendMessageAction(input: {
  conversationId: string
  body: string
  direction: string
}): Promise<ActionResult> {
  await requireAdmin()

  const body = input.body?.trim()
  const direction = input.direction === 'in' ? 'in' : 'out'
  if (!input.conversationId || !body)
    return { ok: false, message: 'Выберите диалог и введите текст' }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [input.conversationId],
  )
  if (!conv[0]) return { ok: false, message: 'Диалог не найден' }

  const author = direction === 'out' ? 'Менеджер' : conv[0].contact_name || 'Клиент'
  await query(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), input.conversationId, direction, body, author],
  )
  await query(
    `UPDATE conversations
        SET last_message = $2,
            last_message_at = now(),
            unread = unread + CASE WHEN $3 = 'in' THEN 1 ELSE 0 END
      WHERE id = $1`,
    [input.conversationId, body, direction],
  )

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Сообщение добавлено в диалог' }
}

export async function secretSetManagerStatusAction(
  id: string,
  status: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id || (status !== 'active' && status !== 'blocked'))
    return { ok: false, message: 'Некорректный статус менеджера' }
  await updateManagerStatus(id, status as ManagerStatus)
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: status === 'blocked' ? 'Менеджер заблокирован' : 'Менеджер разблокирован',
  }
}
