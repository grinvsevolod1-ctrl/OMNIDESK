import { requireAdmin } from '@/lib/auth'
import { query } from '@/lib/db'
import { randomUUID } from 'crypto'

export async function POST(req: Request) {
  await requireAdmin()
  const body = await req.json()
  const { channelId, contactName, contactHandle, message } = body

  if (!channelId || !contactName || !contactHandle) {
    return Response.json({ message: 'Заполните все поля' }, { status: 400 })
  }

  const id = randomUUID()
  await query(
    `INSERT INTO conversations 
     (id, channel_id, channel_type, manager_id, contact_name, contact_handle, last_message, last_message_at, status)
     SELECT $1, $2, ch.type, ch.manager_id, $3, $4, $5, now(), 'liquid'
     FROM channels ch WHERE ch.id = $2`,
    [id, channelId, contactName, contactHandle, message || '']
  )

  if (message) {
    await query(
      `INSERT INTO messages (conversation_id, direction, body, author)
       VALUES ($1, 'in', $2, $3)`,
      [id, message, contactName]
    )
  }

  return Response.json({ message: 'Диалог создан' })
}
