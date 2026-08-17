import { ShieldCheck } from 'lucide-react'
import { CreateHeadDialog } from '@/components/admin/heads/create-head-dialog'
import { HeadsTable } from '@/components/admin/heads/heads-table'
import { EmptyState, PageHeader } from '@/components/page-parts'
import { requireAdmin } from '@/lib/auth'
import { listCurators } from '@/lib/data'
import {
  listCuratorsOfHead,
  listHeads,
  mapCuratorHeads,
} from '@/lib/data/heads'

export default async function HeadsPage() {
  await requireAdmin()
  const [heads, curators, curatorHeads] = await Promise.all([
    listHeads(),
    listCurators(),
    mapCuratorHeads(),
  ])
  const groups = await Promise.all(
    heads.map(async (h) => ({
      head: h,
      curators: await listCuratorsOfHead(h.id),
    })),
  )
  const allCurators = curators.map((c) => ({
    id: c.id,
    name: c.name,
    city: c.city,
    headId: curatorHeads.get(c.id)?.headId ?? null,
    headName: curatorHeads.get(c.id)?.headName ?? null,
  }))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Руководители"
        description="Руководитель видит лид-карточки только своих менеджеров по кадрам. Право «просмотр и редактирование» позволяет менять поля, статусы, писать комментарии и передавать лидов внутри группы."
        action={<CreateHeadDialog />}
      />
      {groups.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Руководителей пока нет"
          description="Создайте руководителя, закрепите за ним менеджеров по кадрам и выберите уровень доступа."
          action={<CreateHeadDialog />}
        />
      ) : (
        <HeadsTable groups={groups} allCurators={allCurators} />
      )}
    </div>
  )
}
