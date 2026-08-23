import { AllLeadsSection } from '@/components/admin/all-leads-section'
import { LeadsHero } from '@/components/admin/leads/leads-hero'
import { LEADS_PAGE_SIZE } from '@/components/admin/leads/period-range'
import { PageHeader } from '@/components/page-parts'
import {
  listActiveCurators,
  listAllTransferredLeads,
} from '@/lib/data/lead-cards'
import { getLeadCardStats } from '@/lib/data/lead-stats'

/**
 * Вкладка «Лиды»: все переданные лиды по всем менеджерам по кадрам.
 * Раньше жила секцией внизу страницы «Менеджеры по кадрам» — вынесена в
 * отдельный раздел. Начальная выборка строго LEADS_PAGE_SIZE (ровно одна
 * страница пагинации), остальное клиент дотягивает сам; статистика hero
 * считается на сервере одним заходом (Promise.all, без водопада).
 */
export default async function AdminLeadsPage() {
  const [allLeads, orphaned, curators, weekStats] = await Promise.all([
    listAllTransferredLeads({ limit: LEADS_PAGE_SIZE }),
    listAllTransferredLeads({ orphanedOnly: true, limit: 1 }),
    listActiveCurators(),
    getLeadCardStats(),
  ])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Лиды"
        description="Все переданные лиды по всем менеджерам по кадрам: статусы, фильтры, статистика по периодам, передача и выгрузка в Excel."
      />

      <LeadsHero
        total={allLeads.total}
        weekStats={weekStats}
        orphanedCount={orphaned.total}
        curatorsCount={curators.length}
      />

      <AllLeadsSection
        initialLeads={allLeads.leads}
        initialTotal={allLeads.total}
        orphanedCount={orphaned.total}
        curators={curators}
      />
    </div>
  )
}
