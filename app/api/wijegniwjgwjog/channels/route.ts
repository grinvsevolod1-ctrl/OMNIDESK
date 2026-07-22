import { listAllChannels } from '@/lib/data'
import { guardGodApi } from '@/lib/god-gate'

export async function GET() {
  const denied = await guardGodApi()
  if (denied) return denied
  const channels = await listAllChannels()
  return Response.json(channels)
}
