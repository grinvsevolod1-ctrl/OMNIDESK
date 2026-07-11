import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { createChannel } from '@/lib/data'
import { inputErrorResponse, readJson } from '@/lib/http/request'
import { serverErrorResponse } from '@/lib/server-log'
import type { ChannelType } from '@/lib/types'

const channelTypes = ['telegram', 'whatsapp', 'livechat', 'max', 'vk'] as const satisfies readonly ChannelType[]
const schema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(channelTypes),
  managerId: z.uuid().nullable().optional(),
  phone: z.string().trim().max(64).optional(),
  token: z.string().trim().max(4096).optional(),
  groupId: z.union([z.string().trim().max(128), z.number().int().safe()]).optional(),
}).strict()

export async function POST(req: Request) {
  await requireAdmin()

  try {
    const { name, type, managerId, phone, token, groupId } = await readJson(req, schema, 16 * 1024)
    const config: Record<string, unknown> = {}
    if (token) config.token = token
    if (groupId !== undefined) config.groupId = groupId
    if (type === 'whatsapp' && phone) config.phoneNumberId = phone

    const channel = await createChannel({
      managerId: managerId ?? null,
      type,
      name,
      detail: phone || `${type} channel`,
      status: 'connected',
      sessionStatus: 'online',
      phone: type === 'telegram' ? phone : null,
      config,
    })

    return Response.json({ message: 'Канал создан', channel })
  } catch (error) {
    return inputErrorResponse(error) ?? serverErrorResponse('admin.create-channel', error)
  }
}
