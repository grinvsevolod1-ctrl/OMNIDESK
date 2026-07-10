import { requireAdmin } from '@/lib/auth'
import { listAllChannels } from '@/lib/data'

export async function GET() {
  await requireAdmin()
  const channels = await listAllChannels()
  return Response.json(channels)
}
