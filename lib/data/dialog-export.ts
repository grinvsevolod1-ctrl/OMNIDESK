/**
 * Полная история диалога для выгрузки файлом.
 *
 * UNSCOPED по владельцу: единственная функция здесь читает ВСЕ сообщения
 * одного диалога в хронологии. Право доступа обязан проверить ВЫЗЫВАЮЩИЙ
 * (role-scoped getter: getConversationForCurator / getConversationForHead)
 * ДО вызова — тот же паттерн, что у markCuratorConversationRead. Экшен
 * `app/actions/dialog-export.ts` — единственная точка входа.
 */
import { query } from '../db'
import type { Message } from '../types'
import {
  MESSAGE_REPLY_JOIN,
  MESSAGE_SELECT,
  toMessage,
  type MessageRow,
} from './shared'

/**
 * Потолок сообщений в одной выгрузке. Защита сервера и браузера от диалога
 * на сотни тысяч строк; реальные переписки с кандидатами — сотни, максимум
 * тысячи сообщений. При превышении берём САМЫЕ СВЕЖИЕ и помечаем truncated.
 */
export const EXPORT_MESSAGE_CAP = 20_000

export async function listAllMessagesForExport(
  conversationId: string,
): Promise<{ messages: Message[]; truncated: boolean }> {
  // +1 к лимиту — чтобы узнать, что за потолком ещё что-то есть, без второго
  // COUNT-запроса.
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_SELECT}
       FROM messages m
       ${MESSAGE_REPLY_JOIN}
      WHERE m.conversation_id = $1
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $2`,
    [conversationId, EXPORT_MESSAGE_CAP + 1],
  )
  const truncated = rows.length > EXPORT_MESSAGE_CAP
  const slice = truncated ? rows.slice(0, EXPORT_MESSAGE_CAP) : rows
  return { messages: slice.reverse().map(toMessage), truncated }
}
