'use server'

import {
  revalidatePath,
} from 'next/cache'
import {
  requireAdmin,
} from '@/lib/auth'
import {
  query,
  withTransaction,
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

  // Semantics: `undefined` = "no change", a provided value (even '') = "set".
  // An empty NAME is a legitimate edit — it clears a mistakenly-set name (the
  // old `name !== ''` guard made a wrong contact_name impossible to erase).
  const name = input.contactName?.trim()
  if (name !== undefined) {
    params.push(name)
    sets.push(`contact_name = $${params.length}`)
  }
  // The HANDLE, however, is the outbound routing address for messenger
  // channels — clearing it would silently break delivery, so an explicit
  // empty value is rejected rather than treated as "no change".
  const handle = input.contactHandle?.trim()
  if (handle !== undefined) {
    if (handle === '') {
      return { ok: false, message: 'Хэндл контакта не может быть пустым' }
    }
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
  // Счётчик и read_at на сообщениях должны меняться согласованно
  // (см. 125_message_read_at.sql), иначе следующий точный пересчёт
  // (например, после god-удаления) откатит этот флаг.
  await withTransaction(async (db) => {
    await db.query(`UPDATE conversations SET unread = $2 WHERE id = $1`, [
      id,
      read ? 0 : 1,
    ])
    if (read) {
      await db.query(
        `UPDATE messages
            SET read_at = now()
          WHERE conversation_id = $1 AND direction = 'in' AND read_at IS NULL`,
        [id],
      )
    } else {
      // «Непрочитано» = последний входящий снова без read_at.
      await db.query(
        `UPDATE messages
            SET read_at = NULL
          WHERE id = (
            SELECT id FROM messages
             WHERE conversation_id = $1 AND direction = 'in'
             ORDER BY created_at DESC, id DESC
             LIMIT 1
          )`,
        [id],
      )
    }
  })
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

  // Atomic: the delete and every counter/preview re-sync land together or not
  // at all, so a mid-flight failure can never leave the conversation row
  // disagreeing with the actual messages.
  await withTransaction(async (db) => {
    const deleted = await db.query<{ direction: 'in' | 'out' }>(
      'DELETE FROM messages WHERE id = $1 RETURNING direction',
      [input.messageId],
    )

    // Re-sync the conversation's last-message preview from whatever remains.
    await db.query(
      `UPDATE conversations c
          SET last_message = COALESCE(m.body, ''),
              last_message_at = COALESCE(m.created_at, c.last_message_at)
         FROM (
           SELECT body, created_at
             FROM messages
            WHERE conversation_id = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 1
         ) m
        WHERE c.id = $1`,
      [input.conversationId],
    )
    // If no rows remain the subquery is empty and the UPDATE ... FROM is a
    // no-op; clear the preview explicitly in that case.
    await db.query(
      `UPDATE conversations
          SET last_message = ''
        WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1)`,
      [input.conversationId],
    )
    // Exact unread recount from message state (see 125_message_read_at.sql):
    // read_at lives on the messages themselves, so deleting a read inbound
    // no longer skews the counter the way a blind decrement did.
    if (deleted[0]?.direction === 'in') {
      await db.query(
        `UPDATE conversations c
            SET unread = (
              SELECT COUNT(*)::int
                FROM messages m
               WHERE m.conversation_id = c.id
                 AND m.direction = 'in'
                 AND m.read_at IS NULL
            )
          WHERE c.id = $1`,
        [input.conversationId],
      )
    }
  })

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Сообщение удалено' }
}
