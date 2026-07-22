import { listManagers } from '@/lib/data'
import { guardGodApi } from '@/lib/god-gate'

export async function GET() {
  const denied = await guardGodApi()
  if (denied) return denied
  const managers = await listManagers()
  return Response.json(managers)
}
