import { requireAdmin } from '@/lib/auth'
import { query } from '@/lib/db'
import { randomUUID } from 'crypto'

export async function POST(req: Request) {
  await requireAdmin()
  const body = await req.json()
  const { conversationId, body: messageBody, direction } = body

  if (!conversationId || !messageBody) {
    return Response.json({ message: 'Заполните все поля' }, { status: 400 })
  }

  const conv = await query(
    `SELECT contact_name FROM conversations WHERE id = $1`,
    [conversationId]
  )

  const author = direction === 'out' ? 'Менеджер' : (conv[0]?.contact_name || 'Клиент')

  await query(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), conversationId, direction, messageBody, author]
  )

  await query(
    `UPDATE conversations SET last_message = $2, last_message_at = now() WHERE id = $1`,
    [conversationId, messageBody]
  )

  return Response.json({ message: 'Сообщение отправлено' })
}
