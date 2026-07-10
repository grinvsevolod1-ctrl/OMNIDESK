import { requireAdmin } from '@/lib/auth'
import { SecretDashboard } from '@/components/admin/secret-dashboard'

export default async function SecretPage() {
  await requireAdmin()
  return <SecretDashboard />
}
