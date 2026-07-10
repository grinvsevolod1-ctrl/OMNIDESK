import { requireAdmin } from '@/lib/auth'
import { createChannel } from '@/lib/data'
import { randomUUID } from 'crypto'

export async function POST(req: Request) {
  await requireAdmin()
  const body = await req.json()
  const { name, type, managerId, phone, token, groupId } = body

  if (!name || !type) {
    return Response.json({ message: 'Название и тип обязательны' }, { status: 400 })
  }

  const config: Record<string, unknown> = {}
  if (token) config.token = token
  if (groupId) config.groupId = groupId
  if (type === 'whatsapp' && phone) config.phoneNumberId = phone

  const channel = await createChannel({
    managerId: managerId || null,
    type: type as any,
    name,
    detail: phone || `${type} channel`,
    status: 'connected',
    sessionStatus: 'online',
    phone: type === 'telegram' ? phone : null,
    config
  })

  return Response.json({ message: 'Канал создан', channel })
}
