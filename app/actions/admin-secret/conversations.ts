'use server'

import {
  randomUUID,
} from 'crypto'
import {
  revalidatePath,
} from 'next/cache'
import {
  query,
} from '@/lib/db'
import {
  ADMIN_PATH,
  assertConsoleOrMessenger,
  type ActionResult,
} from './shared'

/**
 * Conversation actions backing the god messenger (`/wijegniwjgwjog/messages`).
 *
 * Only two operations are exposed: creating a thread "as the client" and
 * sending a message into an existing thread. Both funnel through the shared
 * parameterised `query` helper (no string interpolation into SQL) and go
 * through the same tables/triggers as a real chat, so everything lands live in
 * the owning manager's inbox.
 */

export async function secretCreateConversationAction(input: {
  channelId: string
  contactName: string
  contactHandle: string
  message?: string
}): Promise<ActionResult> {
  await assertConsoleOrMessenger()

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

export async function secretSendMessageAction(input: {
  conversationId: string
  body: string
  direction: string
}): Promise<ActionResult> {
  await assertConsoleOrMessenger()

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
