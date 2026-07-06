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
        description="Доходы и расходы по ресурсам. Добавляйте ресурс (например, site.com), внутри — вкладки (Материалы, Реклама…), а в них записи со статусами, суммами и чек-листом выполненных задач."
      />
      <FinanceAdmin
        resources={data.resources}
        sections={data.sections}
        entries={data.entries}
      />
    </div>
  )
}
