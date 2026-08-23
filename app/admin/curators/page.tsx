import { ArrowRight, MapPin } from 'lucide-react'
import Link from 'next/link'
import { CreateCuratorDialog } from '@/components/admin/create-curator-dialog'
import { CuratorsTable } from '@/components/admin/curators-table'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { listCurators } from '@/lib/data'
import {
  getCuratorDiscipline,
  getCuratorDisciplineHistory,
  listActiveCurators,
  type CuratorDisciplineHistory,
} from '@/lib/data/lead-cards'

export default async function CuratorsPage() {
  const [curators, discipline, history, activeCurators] = await Promise.all([
    listCurators(),
    getCuratorDiscipline(),
    getCuratorDisciplineHistory(30).catch(
      () => new Map<string, CuratorDisciplineHistory>(),
    ),
    listActiveCurators(),
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

      {/* Все лиды переехали в отдельный раздел /admin/leads. */}
      <Link
        href="/admin/leads"
        className="group inline-flex items-center gap-1.5 self-start text-sm font-medium text-primary hover:underline"
      >
        Все лиды по всем менеджерам по кадрам
        <ArrowRight
          className="size-4 transition-transform group-hover:translate-x-0.5"
          aria-hidden
        />
      </Link>
    </div>
  )
}
