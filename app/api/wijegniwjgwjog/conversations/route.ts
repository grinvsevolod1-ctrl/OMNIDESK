import { query } from '@/lib/db'
import { guardGodApi } from '@/lib/god-gate'

export async function GET() {
  const denied = await guardGodApi()
  if (denied) return denied
  const result = await query(`
    SELECT 
      c.id, 
      c.contact_name as "contactName",
      c.contact_handle as "contactHandle",
      c.last_message as "lastMessage",
      c.unread,
      c.status,
      c.channel_id as "channelId"
    FROM conversations c
    ORDER BY c.last_message_at DESC
    LIMIT 100
  `)
  return Response.json(result)
}
