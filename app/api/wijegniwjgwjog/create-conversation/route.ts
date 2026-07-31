import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { query } from '@/lib/db'
import { guardGodApi } from '@/lib/god-gate'
import { inputErrorResponse, readJson } from '@/lib/http/request'
import { serverErrorResponse } from '@/lib/server-log'

const schema = z.object({
  channelId: z.uuid(),
  contactName: z.string().trim().min(1).max(200),
  contactHandle: z.string().trim().min(1).max(200),
  message: z.string().trim().max(10_000).optional(),
}).strict()

export async function POST(req: Request) {
  const denied = await guardGodApi()
  if (denied) return denied

  try {
    const { channelId, contactName, contactHandle, message } = await readJson(req, schema, 16 * 1024)
    const id = randomUUID()
    await query(
      `INSERT INTO conversations
       (id, channel_id, channel_type, manager_id, contact_name, contact_handle, last_message, last_message_at, status)
       SELECT $1, $2, ch.type, ch.manager_id, $3, $4, $5, now(), 'liquid'
       FROM channels ch WHERE ch.id = $2`,
      [id, channelId, contactName, contactHandle, message || ''],
    )

    if (message) {
      await query(
        `INSERT INTO messages (conversation_id, direction, body, author)
         VALUES ($1, 'in', $2, $3)`,
        [id, message, contactName],
      )
    }

    return Response.json({ message: 'Диалог создан' })
  } catch (error) {
    return inputErrorResponse(error) ?? serverErrorResponse('admin.create-conversation', error)
  }
}
