'use server'

import {
  revalidatePath,
} from 'next/cache'
import {
  requireAdmin,
} from '@/lib/auth'
import {
  query,
} from '@/lib/db'
import {
  ADMIN_PATH,
  type ActionResult,
} from './shared'

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

/**
 * Toggle the contact-side block flag: simulates the CLIENT blocking (or
 * unblocking) our manager in the messenger. Purely a state marker surfaced in
 * the god console — it doesn't stop ingestion.
 */
export async function secretSetContactBlockedAction(
  id: string,
  blocked: boolean,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан диалог' }
  await query(
    `UPDATE conversations SET contact_blocked = $2 WHERE id = $1`,
    [id, blocked],
  )
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: blocked ? 'Менеджер заблокирован клиентом' : 'Менеджер разблокирован',
  }
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
