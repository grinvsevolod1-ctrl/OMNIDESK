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

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Кураторы"
          description="Кураторы отвечают за город. Создавать может только администратор. Нажмите на куратора, чтобы открыть его лиды."
          action={<CreateCuratorDialog />}
        />

        {curators.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="Кураторов пока нет"
            description="Создайте куратора и укажите город, за который он отвечает."
            action={<CreateCuratorDialog />}
          />
        ) : (
          <CuratorsTable
            curators={curators}
            discipline={disciplineById}
            history={historyById}
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
