import { requireAdmin } from '@/lib/auth'
import { listManagers } from '@/lib/data'

export async function GET() {
  await requireAdmin()
  const managers = await listManagers()
  return Response.json(managers)
}
