import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { query, withTransaction } from '@/lib/db'
import { inputErrorResponse, readJson } from '@/lib/http/request'
import { serverErrorResponse } from '@/lib/server-log'

const schema = z.object({
  conversationId: z.uuid(),
  body: z.string().trim().min(1).max(10_000),
  direction: z.enum(['in', 'out']),
}).strict()

export async function POST(req: Request) {
  await requireAdmin()

  try {
    const { conversationId, body, direction } = await readJson(req, schema, 16 * 1024)
    const conv = await query<{ contact_name: string }>(
      'SELECT contact_name FROM conversations WHERE id = $1',
      [conversationId],
    )
    if (!conv[0]) {
      return Response.json({ message: 'Диалог не найден' }, { status: 404 })
    }

    const author = direction === 'out' ? 'Менеджер' : conv[0].contact_name
    const requestedKey = req.headers.get('idempotency-key')?.trim()
    const messageId = requestedKey && z.uuid().safeParse(requestedKey).success
      ? requestedKey
      : randomUUID()

    const inserted = await withTransaction(async (db) => {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO messages (id, conversation_id, direction, body, author)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [messageId, conversationId, direction, body, author],
      )
      if (rows.length === 0) return false

      await db.query(
        'UPDATE conversations SET last_message = $2, last_message_at = now() WHERE id = $1',
        [conversationId, body],
      )
      return true
    })

    return Response.json({
      message: 'Сообщение отправлено',
      messageId,
      duplicate: !inserted,
    })
  } catch (error) {
    return inputErrorResponse(error) ?? serverErrorResponse('admin.send-message', error)
  }
}
