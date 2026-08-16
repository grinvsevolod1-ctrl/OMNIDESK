import { MapPin } from 'lucide-react'
import { AllLeadsSection } from '@/components/admin/all-leads-section'
import { CreateCuratorDialog } from '@/components/admin/create-curator-dialog'
import { CuratorsTable } from '@/components/admin/curators-table'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { listCurators } from '@/lib/data'
import {
  getCuratorDiscipline,
  getCuratorDisciplineHistory,
  listActiveCurators,
  listAllTransferredLeads,
  type CuratorDisciplineHistory,
} from '@/lib/data/lead-cards'

export default async function CuratorsPage() {
  const [curators, discipline, history, activeCurators, allLeads, orphaned] =
    await Promise.all([
      listCurators(),
      getCuratorDiscipline(),
      getCuratorDisciplineHistory(30).catch(
        () => new Map<string, CuratorDisciplineHistory>(),
      ),
      listActiveCurators(),
      listAllTransferredLeads({ limit: 50 }),
      listAllTransferredLeads({ orphanedOnly: true, limit: 1 }),
    ])

  const disciplineById = Object.fromEntries(
    discipline.map((d) => [d.curatorId, d]),
  )
  const historyById = Object.fromEntries(history)
  // Multi-city map (curator_cities): show every covered city in the table.
  const citiesById = Object.fromEntries(
    activeCurators.map((c) => [c.id, c.cities]),
  )

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Менеджеры по кадрам"
          description="Менеджер по кадрам может вести один или несколько городов. Создавать может только администратор. Нажмите на менеджера по кадрам, чтобы открыть его лиды."
          action={<CreateCuratorDialog />}
        />

        {curators.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="Менеджеров по кадрам пока нет"
            description="Создайте менеджера по кадрам и укажите города, за которые он отвечает."
            action={<CreateCuratorDialog />}
          />
        ) : (
          <CuratorsTable
            curators={curators}
            discipline={disciplineById}
            history={historyById}
            citiesById={citiesById}
          />
        )}
      </div>

      <AllLeadsSection
        initialLeads={allLeads.leads}
        initialTotal={allLeads.total}
        orphanedCount={orphaned.total}
        curators={activeCurators}
      />
    </div>
  )
}
