import { PageHeader } from '@/components/page-parts'
import { WhatsappAdmin } from '@/components/admin/whatsapp-admin'
import {
  ensureWhatsappVerifyToken,
  getWhatsappAppStatus,
  listManagers,
  listWhatsappNumbers,
} from '@/lib/data'
import { resolveAppBaseUrl } from '@/lib/app-url'

export default async function AdminWhatsappPage() {
  // Provision a verify token up front so the admin can register the Meta webhook
  // immediately — before entering a working access token. This breaks the
  // chicken-and-egg where Meta verification failed with "not_configured".
  await ensureWhatsappVerifyToken()

  const [status, numbers, managers] = await Promise.all([
    getWhatsappAppStatus(),
    listWhatsappNumbers(),
    listManagers(),
  ])

  // The app-level callback URL is stable (no channel id). Resolve the public
  // base URL; fall back to a hint if it can't be determined.
  let callbackUrl = ''
  let baseUrlError: string | null = null
  try {
    callbackUrl = `${await resolveAppBaseUrl()}/api/whatsapp/webhook`
  } catch (err) {
    baseUrlError =
      err instanceof Error ? err.message : 'Не удалось определить URL приложения.'
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="WhatsApp"
        description="Подключите приложение Meta Cloud API один раз, затем добавляйте номера и назначайте их менеджерам."
      />
      <WhatsappAdmin
        status={status}
        numbers={numbers}
        managers={managers}
        callbackUrl={callbackUrl}
        baseUrlError={baseUrlError}
      />
    </div>
  )
}
