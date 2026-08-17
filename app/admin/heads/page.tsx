import { ShieldCheck } from 'lucide-react'
import { listHeadsAdminAction } from '@/app/actions/admin-heads'
import { CreateHeadDialog } from '@/components/admin/heads/create-head-dialog'
import { HeadsTable } from '@/components/admin/heads/heads-table'
import { EmptyState, PageHeader } from '@/components/page-parts'

export default async function HeadsPage() {
  // Единый источник данных с action панели: руководители, состав их групп
  // (кураторы + менеджеры продаж) и справочники для назначения.
  const { groups, allCurators, allManagers } = await listHeadsAdminAction()

  const toAssignable = (m: {
    id: string
    name: string
    city: string | null
    headId: string | null
    headName: string | null
  }) => ({
    id: m.id,
    name: m.name,
    city: m.city,
    headId: m.headId,
    headName: m.headName,
  })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Руководители"
        description="Руководитель видит лид-карточки своих менеджеров по кадрам и своих менеджеров продаж. Право «просмотр и редактирование» позволяет менять поля, статусы, писать комментарии и передавать лидов внутри группы."
        action={<CreateHeadDialog />}
      />
      {groups.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Руководителей пока нет"
          description="Создайте руководителя, закрепите за ним кураторов и менеджеров и выберите уровень доступа."
          action={<CreateHeadDialog />}
        />
      ) : (
        <HeadsTable
          groups={groups}
          allCurators={allCurators.map(toAssignable)}
          allManagers={allManagers.map(toAssignable)}
        />
      )}
    </div>
  )
}
