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
        description="Расходы и реклама по ресурсам. Добавьте ресурс (например, site.com), заведите рекламные кабинеты с балансом и статистикой (лиды, клики, CPL), а также ведите расходы по вкладкам с чек-листом задач."
      />
      <FinanceAdmin
        resources={data.resources}
        sections={data.sections}
        entries={data.entries}
        adAccounts={data.adAccounts}
      />
    </div>
  )
}
