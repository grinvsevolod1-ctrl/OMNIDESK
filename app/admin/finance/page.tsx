import { FinanceAdmin } from '@/components/admin/finance-admin'
import { PageHeader } from '@/components/page-parts'
import { requireAdmin } from '@/lib/auth'
import { getFinanceData } from '@/lib/finance'

// Учёт зависит от «живых» данных БД — не кэшируем на этапе сборки.
export const dynamic = 'force-dynamic'

export default async function AdminFinancePage() {
  await requireAdmin()
  const data = await getFinanceData()

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Учёт"
        description="Единое хранилище проекта: расходы и реклама по ресурсам плюс защищённое хранилище всех данных — учётные записи, сервера, аккаунты, ники, счета и оплаты. Пароли и секреты шифруются (AES-256-GCM)."
      />
      <FinanceAdmin
        resources={data.resources}
        sections={data.sections}
        entries={data.entries}
        adAccounts={data.adAccounts}
        vaultItems={data.vaultItems}
        encryptionReady={data.encryptionReady}
      />
    </div>
  )
}
