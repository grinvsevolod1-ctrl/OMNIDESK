import { MapPin } from 'lucide-react'
import { CreateCuratorDialog } from '@/components/admin/create-curator-dialog'
import { CuratorsTable } from '@/components/admin/curators-table'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { listCurators } from '@/lib/data'

export default async function CuratorsPage() {
  const curators = await listCurators()

  return (
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
        <CuratorsTable curators={curators} />
      )}
    </div>
  )
}
