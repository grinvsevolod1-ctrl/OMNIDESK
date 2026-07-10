'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { query } from '@/lib/db'
import {
  createChannel,
  deleteChannelById,
  getConversationAdmin,
  listConversationsAdmin,
  listMessagesAdmin,
  updateManagerStatus,
} from '@/lib/data'
import type {
  ChannelType,
  Conversation,
  ManagerStatus,
  Message,
} from '@/lib/types'

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

/* ===================================================================== */
/*  Bulk conversation generator ("Наплыв")                               */
/*  Spins up N realistic-looking conversations across the chosen channels*/
/*  with randomised contacts, statuses and timestamps spread over a time */
/*  window — simulating a sudden flood/glitch of incoming chats. Each     */
/*  conversation goes through the same tables/triggers as a real one, so  */
/*  they appear live in the owning manager's inbox.                       */
/* ===================================================================== */

const FAKE_FIRST_NAMES = [
  'Александр', 'Мария', 'Дмитрий', 'Анна', 'Сергей', 'Екатерина', 'Иван',
  'Ольга', 'Максим', 'Наталья', 'Андрей', 'Виктория', 'Павел', 'Юлия',
  'Никита', 'Дарья', 'Роман', 'Ксения', 'Артём', 'Полина', 'Егор', 'София',
]

const FAKE_LAST_NAMES = [
  'Иванов', 'Смирнова', 'Кузнецов', 'Попова', 'Соколов', 'Лебедева',
  'Козлов', 'Новикова', 'Морозов', 'Волкова', 'Петров', 'Фёдорова',
  'Михайлов', 'Егорова', 'Никитин', 'Орлова', 'Захаров', 'Павлова',
]

const FAKE_MESSAGES = [
  'Здравствуйте! Подскажите, актуально ещё предложение?',
  'Добрый день, хочу уточнить по цене',
  'Привет, а доставка в другой город есть?',
  'Можно подробнее про условия?',
  'Здравствуйте, оставлял заявку — что дальше?',
  'Интересует ваш продукт, как оформить?',
  'Добрый вечер! Вы работаете сегодня?',
  'Подскажите сроки, пожалуйста',
  'А есть скидка при заказе от нескольких штук?',
  'Хочу записаться на консультацию',
  'Скиньте, пожалуйста, прайс',
  'Не приходит ответ, вы на связи?',
]

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomHandle(type: string): string {
  const n = Math.floor(1000 + Math.random() * 9_000_000)
  switch (type) {
    case 'telegram':
      return `@user_${n}`
    case 'whatsapp':
      return `+79${String(Math.floor(100_000_000 + Math.random() * 899_999_999))}`
    case 'vk':
      return `id${n}`
    case 'max':
      return `max_${n}`
    default:
      return `web-${n.toString(36)}`
  }
}

export interface BulkResult extends ActionResult {
  created: number
}

export async function secretBulkCreateConversationsAction(input: {
  count: number
  channelIds?: string[]
  spreadHours: number
  withMessage: boolean
  markUnread: boolean
}): Promise<BulkResult> {
  await requireAdmin()

  const count = Math.min(Math.max(Math.floor(input.count) || 0, 1), 100)
  const spreadHours = Math.min(Math.max(input.spreadHours || 24, 0), 24 * 90)

  // Only channels that actually have an owner can host a conversation.
  const idFilter = input.channelIds?.length ? input.channelIds : null
  const channels = await query<{ id: string; type: string; manager_id: string }>(
    `SELECT id, type, manager_id
       FROM channels
      WHERE manager_id IS NOT NULL
        AND ($1::text[] IS NULL OR id = ANY($1::text[]))`,
    [idFilter],
  )
  if (channels.length === 0)
    return {
      ok: false,
      created: 0,
      message: 'Нет подходящих каналов с назначенным менеджером',
    }

  let created = 0
  for (let i = 0; i < count; i++) {
    const channel = pickRandom(channels)
    const first = pickRandom(FAKE_FIRST_NAMES)
    const last = pickRandom(FAKE_LAST_NAMES)
    const name = `${first} ${last}`
    const handle = randomHandle(channel.type)
    const status = pickRandom(CONVERSATION_STATUSES)
    const offsetMinutes = Math.floor(Math.random() * spreadHours * 60)
    const body = input.withMessage ? pickRandom(FAKE_MESSAGES) : ''
    const unread = input.markUnread && input.withMessage ? 1 : 0
    const convId = randomUUID()

    await query(
      `INSERT INTO conversations
         (id, channel_id, channel_type, manager_id, contact_name, contact_handle,
          last_message, last_message_at, status, unread)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               now() - ($8 * interval '1 minute'), $9, $10)`,
      [
        convId,
        channel.id,
        channel.type,
        channel.manager_id,
        name,
        handle,
        body,
        offsetMinutes,
        status,
        unread,
      ],
    )

    if (input.withMessage) {
      await query(
        `INSERT INTO messages (id, conversation_id, direction, body, author, created_at)
         VALUES ($1, $2, 'in', $3, $4, now() - ($5 * interval '1 minute'))`,
        [randomUUID(), convId, body, name, offsetMinutes],
      )
    }
    created++
  }

  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    created,
    message: `Создано диалогов: ${created}`,
  }
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

/* ===================================================================== */
/*  God-mode Conversation Console                                        */
/*  These power the live two-pane console where the admin impersonates   */
/*  the CLIENT (inbound messages) to talk to their own managers. Every   */
/*  insert goes through the same `messages`/`conversations` tables whose */
/*  triggers fire pg_notify('realtime', …) — so a message written here   */
/*  lands in the target manager's real inbox live, exactly like a genuine*/
/*  incoming message would.                                              */
/* ===================================================================== */

export type ConversationWithManager = Conversation & { managerName: string | null }

/** Live-searchable list of every conversation (admin-wide, no manager scope). */
export async function secretListConversationsAction(opts?: {
  search?: string
  channelType?: string
}): Promise<ConversationWithManager[]> {
  await requireAdmin()
  const channelType =
    opts?.channelType && opts.channelType !== 'all'
      ? (opts.channelType as ChannelType)
      : undefined
  return listConversationsAdmin({ search: opts?.search, channelType })
}

export interface ThreadResult {
  ok: boolean
  message?: string
  conversation: ConversationWithManager | null
  messages: Message[]
}

/** Full transcript + metadata for one conversation (admin-wide). */
export async function secretFetchThreadAction(
  conversationId: string,
): Promise<ThreadResult> {
  await requireAdmin()
  if (!conversationId)
    return { ok: false, message: 'Не указан диалог', conversation: null, messages: [] }
  const conversation = await getConversationAdmin(conversationId)
  if (!conversation)
    return { ok: false, message: 'Диалог не найден', conversation: null, messages: [] }
  const messages = await listMessagesAdmin(conversationId)
  return { ok: true, conversation, messages }
}

export interface SendResult extends ActionResult {
  createdMessage: Message | null
}

/**
 * Write a message AS THE CLIENT (inbound). This is the core god-mode feature:
 * it simulates the contact writing in, so the owning manager sees it arrive in
 * their inbox in real time and can reply. Never writes as the manager.
 */
export async function secretSendAsClientAction(input: {
  conversationId: string
  body: string
}): Promise<SendResult> {
  await requireAdmin()
  const body = input.body?.trim()
  if (!input.conversationId || !body)
    return { ok: false, message: 'Выберите диалог и введите текст', createdMessage: null }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [input.conversationId],
  )
  if (!conv[0])
    return { ok: false, message: 'Диалог не найден', createdMessage: null }

  const author = conv[0].contact_name || 'Клиент'
  const rows = await query<{ id: string; created_at: string | Date }>(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, 'in', $3, $4)
     RETURNING id, created_at`,
    [randomUUID(), input.conversationId, body, author],
  )
  await query(
    `UPDATE conversations
        SET last_message = $2, last_message_at = now(), unread = unread + 1
      WHERE id = $1`,
    [input.conversationId, body],
  )

  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: 'Отправлено от имени клиента',
    createdMessage: {
      id: rows[0].id,
      conversationId: input.conversationId,
      direction: 'in',
      body,
      author,
      createdAt: new Date(rows[0].created_at).toISOString(),
    },
  }
}

/** Edit a conversation's contact identity and/or reassign it to a manager. */
export async function secretUpdateConversationAction(input: {
  id: string
  contactName?: string
  contactHandle?: string
  managerId?: string
}): Promise<ActionResult> {
  await requireAdmin()
  if (!input.id) return { ok: false, message: 'Не указан диалог' }

  const sets: string[] = []
  const params: unknown[] = [input.id]

  const name = input.contactName?.trim()
  if (name !== undefined && name !== '') {
    params.push(name)
    sets.push(`contact_name = $${params.length}`)
  }
  const handle = input.contactHandle?.trim()
  if (handle !== undefined && handle !== '') {
    params.push(handle)
    sets.push(`contact_handle = $${params.length}`)
  }
  if (input.managerId) {
    const mgr = await query<{ id: string }>(
      'SELECT id FROM managers WHERE id = $1 LIMIT 1',
      [input.managerId],
    )
    if (!mgr[0]) return { ok: false, message: 'Менеджер не найден' }
    params.push(input.managerId)
    sets.push(`manager_id = $${params.length}`)
  }

  if (sets.length === 0) return { ok: false, message: 'Нет изменений' }

  await query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $1`, params)
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Диалог обновлён' }
}

/** Reset or raise the unread counter on the manager's side. */
export async function secretSetUnreadAction(
  id: string,
  read: boolean,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан диалог' }
  await query(
    `UPDATE conversations SET unread = $2 WHERE id = $1`,
    [id, read ? 0 : 1],
  )
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: read ? 'Отмечено прочитанным' : 'Отмечено непрочитанным' }
}

/** Hard-delete a single message and recompute the conversation preview. */
export async function secretDeleteMessageAction(input: {
  messageId: string
  conversationId: string
}): Promise<ActionResult> {
  await requireAdmin()
  if (!input.messageId || !input.conversationId)
    return { ok: false, message: 'Не указано сообщение' }

  await query('DELETE FROM messages WHERE id = $1', [input.messageId])

  // Re-sync the conversation's last-message preview from whatever remains.
  await query(
    `UPDATE conversations c
        SET last_message = COALESCE(m.body, ''),
            last_message_at = COALESCE(m.created_at, c.last_message_at)
       FROM (
         SELECT body, created_at
           FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC
          LIMIT 1
       ) m
      WHERE c.id = $1`,
    [input.conversationId],
  )
  // If no rows remain the subquery is empty and the UPDATE ... FROM is a no-op;
  // clear the preview explicitly in that case.
  await query(
    `UPDATE conversations
        SET last_message = ''
      WHERE id = $1
        AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1)`,
    [input.conversationId],
  )

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Сообщение удалено' }
}
