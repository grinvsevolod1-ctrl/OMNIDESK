import { requireAdmin } from '@/lib/auth'
import { query } from '@/lib/db'

export async function GET() {
  await requireAdmin()
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
