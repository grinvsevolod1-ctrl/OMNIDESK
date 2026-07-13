import { FinanceAdmin } from '@/components/admin/finance-admin'
import { PageHeader } from '@/components/page-parts'
import { requireAdmin } from '@/lib/auth'
import { getResourceLeadCounts } from '@/lib/data/analytics'
import { getFinanceData } from '@/lib/finance'
import { getUsdRates } from '@/lib/fx'

// Учёт зависит от «живых» данных БД — не кэшируем на этапе сборки.
export const dynamic = 'force-dynamic'

export default async function AdminFinancePage() {
  await requireAdmin()
  const [data, rates] = await Promise.all([getFinanceData(), getUsdRates()])

  // Реальные лиды по каждому источнику: обращения из привязанных каналов
  // (единая логика с «Обзором»), а не выдуманные числа из кабинетов.
  const resourceLeads = await getResourceLeadCounts(
    data.resources.map((r) => r.id),
  )

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Учёт"
        description="Источники лидов, рекламные кабинеты и расходы. Все суммы приводятся к USD по курсу на момент операции."
      />
      <FinanceAdmin
        resources={data.resources}
        sections={data.sections}
        entries={data.entries}
        adAccounts={data.adAccounts}
        vaultItems={data.vaultItems}
        encryptionReady={data.encryptionReady}
        rates={rates}
        resourceLeads={resourceLeads}
      />
    </div>
  )
}
